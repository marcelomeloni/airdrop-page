require('dotenv').config();
const express = require('express');
const { TwitterApi } = require('twitter-api-v2');
const session = require('express-session');
const cors = require('cors');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// 1) Ajuste aqui para o @ que você quer verificar:
const TWITTER_TARGET_USER = 'sunaryum';
const CLAIM_ENERGY = 50;

// 2) Configure seu app no portal de desenvolvedor Twitter e coloque essas variáveis no .env:
//    TWITTER_CONSUMER_KEY=xxx
//    TWITTER_CONSUMER_SECRET=yyy
//    SESSION_SECRET=algum‐segredo‐aleatorio
//
//    e crie um arquivo .env na raiz contendo exatamente essas três entradas.

const twitterClient = new TwitterApi({
  appKey: process.env.TWITTER_CONSUMER_KEY,
  appSecret: process.env.TWITTER_CONSUMER_SECRET,
});

// 3) configurações básicas do Express:
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'fallback‐secret',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false /* em produção, use HTTPS+secure:true */ },
  })
);

app.use(
  cors({
    origin: 'http://localhost:5500', // substitua pela origem do seu front se diferente
    credentials: true,
  })
);

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// 4) “Banco” em memória
const claimsDB = new Map();

/** middleware que garante que venha wallet_address no body / params */
const verifyWallet = (req, res, next) => {
  const walletAddress = req.body.wallet_address || req.params.walletAddress;
  if (!walletAddress) {
    return res.status(400).json({ error: 'Wallet address is required' });
  }
  req.walletAddress = walletAddress;
  next();
};

/** Salva a wallet na sessão antes de trocar o usuário do Twitter */
app.post('/save-wallet-session', (req, res) => {
  const { walletAddress } = req.body;
  if (!walletAddress) {
    return res.status(400).json({ error: 'Wallet address is required' });
  }
  req.session.walletAddress = walletAddress;
  return res.json({ success: true });
});

/** PASSO 1: redireciona o usuário para Twitter OAuth 1.0a */
app.get('/twitter/auth', async (req, res) => {
  try {
    // no portal Twitter, configure exatamente essa URL como Callback: http://localhost:3000/twitter/callback
    const callbackUrl = `${
      process.env.BASE_URL || 'http://localhost:3000'
    }/twitter/callback`;

    const { url, oauth_token, oauth_token_secret } =
      await twitterClient.generateAuthLink(callbackUrl);

    req.session.oauth_token = oauth_token;
    req.session.oauth_token_secret = oauth_token_secret;
    return res.redirect(url);
  } catch (err) {
    console.error('Erro gerando OAuth link:', err);
    return res
      .status(500)
      .json({ error: 'Falha ao iniciar autenticação no Twitter' });
  }
});

/**
 *  VERIFICAÇÃO DE “FOLLOW” VIA SCRAPING (usando mobile.twitter.com)
 *  – Nosso plano gratuito não permite o endpoint que checa direto, então
 *    vamos pegar a lista de /followers do alvo e procurar “/usuário” no HTML.
 */
async function checkIfUserFollows(userClient, sourceUsername) {
  try {
    console.log(`→ Verificação direta se @${sourceUsername} segue @${TWITTER_TARGET_USER}`);
    
    // 1. Obter ID do alvo
    const targetUser = await userClient.v2.userByUsername(TWITTER_TARGET_USER);
    const targetUserId = targetUser.data.id;

    // 2. Verificar follow usando o endpoint mais simples possível
    const follows = await userClient.v2.following(sourceUsername, {
      max_results: 100,
      'user.fields': ['username']
    });

    // 3. Procurar o alvo na lista de seguindo
    const found = follows.data.some(user => 
      user.username.toLowerCase() === TWITTER_TARGET_USER.toLowerCase()
    );

    console.log(found ? '✔ Segue' : '✖ Não segue');
    return found;
    
  } catch (err) {
    console.error('Erro na verificação:', err);
    return false;
  }
}

/**
 *  CALLBACK do OAuth 1.0a. O Twitter redireciona aqui depois que o usuário
 *  aceitar no Twitter. Troca tokens, obtém o screen_name e joga numa “claimsDB”.
 */
app.get('/twitter/callback', async (req, res) => {
  const { oauth_token, oauth_verifier } = req.query;
  const session_oauth_token = req.session.oauth_token;
  const session_oauth_token_secret = req.session.oauth_token_secret;

  if (session_oauth_token !== oauth_token) {
    return res.status(400).send('Token inválido');
  }

  try {
    // 1) troca por um client autenticado de usuário
    const tempClient = new TwitterApi({
      appKey: process.env.TWITTER_CONSUMER_KEY,
      appSecret: process.env.TWITTER_CONSUMER_SECRET,
      accessToken: oauth_token,
      accessSecret: session_oauth_token_secret,
    });

    const { client: userClient } = await tempClient.login(oauth_verifier);

    // 2) pegar o próprio screen_name do usuário autenticado
    const { data: userData } = await userClient.v2.me({
      'user.fields': ['id', 'username'],
    });
    const sourceUsername = userData.username;

    // 3) verificar se segue o alvo via scraping
    const follows = await checkIfUserFollows(userClient, sourceUsername);

    // 4) gerar um token único e salvar num “DB” em memória
    const verificationToken = uuidv4();
    claimsDB.set(verificationToken, {
      userId: userData.id,
      screenName: sourceUsername,
      follows, // true ou false
      walletAddress: req.session.walletAddress,
      verifiedAt: new Date(),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 min
    });

    // 5) devolve um HTML que faz postMessage() no popup
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head><title>Auth completa</title></head>
      <body>
        <script>
          window.opener.postMessage(
            {
              type: 'TWITTER_AUTH_COMPLETE',
              success: true,
              token: '${verificationToken}'
            },
            '*'
          );
          window.close();
        </script>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('Erro no callback:', err);
    return res.status(500).send(`
      <!DOCTYPE html>
      <html>
      <head><title>Auth falhou</title></head>
      <body>
        <script>
          window.opener.postMessage(
            {
              type: 'TWITTER_AUTH_COMPLETE',
              success: false,
              error: 'Falha na autenticação'
            },
            '*'
          );
          window.close();
        </script>
      </body>
      </html>
    `);
  }
});

/**
 *  Depois que o popup do /twitter/callback fizer postMessage com { token },
 *  o front chama este endpoint para saber “verified: true/false”.
 */
app.post('/twitter/verify-follow', verifyWallet, (req, res) => {
  const { token } = req.body;
  const walletAddress = req.walletAddress;

  if (!token) {
    return res
      .status(400)
      .json({ verified: false, error: 'Token de verificação obrigatório' });
  }

  const entry = claimsDB.get(token);
  if (!entry) {
    return res.json({ verified: false, error: 'Token inválido ou expirado' });
  }
  if (entry.walletAddress !== walletAddress) {
    return res.json({ verified: false, error: 'Token não corresponde à wallet' });
  }
  if (new Date() > entry.expiresAt) {
    claimsDB.delete(token);
    return res.json({ verified: false, error: 'Token expirado' });
  }

  return res.json({
    verified: entry.follows,
    twitterHandle: entry.screenName,
  });
});

/**
 *  POST /claim-reward — consome esse mesmo token e marca como “claimed”.
 */
app.post('/claim-reward', verifyWallet, (req, res) => {
  const { token } = req.body;
  const walletAddress = req.walletAddress;

  if (!token) {
    return res
      .status(400)
      .json({ success: false, error: 'Token de verificação obrigatório' });
  }

  const entry = claimsDB.get(token);
  if (!entry) {
    return res.json({ success: false, error: 'Token inválido ou expirado' });
  }
  if (entry.walletAddress !== walletAddress) {
    return res.json({ success: false, error: 'Token não corresponde à wallet' });
  }
  if (new Date() > entry.expiresAt) {
    claimsDB.delete(token);
    return res.json({ success: false, error: 'Token expirado' });
  }
  if (!entry.follows) {
    return res.json({ success: false, error: 'Você não segue @sunaryum' });
  }
  if (entry.claimed) {
    return res.json({
      success: false,
      error: 'Recompensa já reivindicada para esta verificação',
    });
  }

  entry.claimed = true;
  entry.claimedAt = new Date();
  claimsDB.set(token, entry);

  console.log(
    `→ CLAIM: wallet ${walletAddress} (user=${entry.screenName}) recebeu ${CLAIM_ENERGY}`
  );
  return res.json({
    success: true,
    message: `Recompensa de ${CLAIM_ENERGY} energia reivindicada com sucesso!`,
    energy: CLAIM_ENERGY,
    twitterHandle: entry.screenName,
  });
});

/** 
 * Opcional: endpoint que retorna status de todos os claims de uma wallet 
 */
app.get('/claim-status/:walletAddress', (req, res) => {
  const walletAddress = req.params.walletAddress;
  const list = [];

  for (const [token, data] of claimsDB) {
    if (data.walletAddress === walletAddress) {
      list.push({
        twitterHandle: data.screenName,
        claimed: data.claimed || false,
        claimedAt: data.claimedAt,
        verifiedAt: data.verifiedAt,
      });
    }
  }
  return res.json({ claims: list });
});
app.get('/airdrop', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'test.html'));
});
/** Rota simples para teste /health */
app.get('/health', (req, res) => {
  return res.json({
    status: 'online',
    claimsCount: claimsDB.size,
    uptime: process.uptime(),
  });
});

/** Inicia o servidor */
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Frontend (origem CORS): http://localhost:5500`);
  console.log(`Verificando follows de: @${TWITTER_TARGET_USER}`);
});
