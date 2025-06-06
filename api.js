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
async function checkIfUserFollows(sourceUsername) {
  try {
    console.log(`→ iniciando scraping para ver se @${sourceUsername} segue @${TWITTER_TARGET_USER}`);
    
    // Normaliza os usernames para minúsculas
    const sourceLower = sourceUsername.toLowerCase();
    const targetLower = TWITTER_TARGET_USER.toLowerCase();
    
    // 1. Tenta encontrar na lista de seguidores do alvo
    try {
      const followersResp = await axios.get(
        `https://mobile.twitter.com/${TWITTER_TARGET_USER}/followers`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
          },
          timeout: 20000,
        }
      );

      const followersHtml = followersResp.data.toLowerCase();
      if (
        followersHtml.includes(`href="/${sourceLower}"`) || 
        followersHtml.includes(`>@${sourceLower}<`)
      ) {
        console.log('✔ encontrado nos seguidores (via página de seguidores)');
        return true;
      }
    } catch (e) {
      console.log('  • falhou em /followers');
    }

    // 2. Tenta encontrar na lista de "seguindo" do usuário
    try {
      const followingResp = await axios.get(
        `https://mobile.twitter.com/${sourceUsername}/following`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
          },
          timeout: 20000,
        }
      );

      const followingHtml = followingResp.data.toLowerCase();
      if (
        followingHtml.includes(`href="/${targetLower}"`) || 
        followingHtml.includes(`>@${targetLower}<`)
      ) {
        console.log('✔ encontrado na lista “seguindo” (via scraping)');
        return true;
      }
    } catch (e) {
      console.log('  • falhou em /following');
    }

    // 3. Verifica indicadores na página de perfil do usuário
    try {
      const profileResp = await axios.get(
        `https://mobile.twitter.com/${sourceUsername}`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
          },
          timeout: 15000,
        }
      );

      const profileHtml = profileResp.data.toLowerCase();
      
      // Padrões de texto que indicam "Seguindo"
      const followPatterns = [
        '>seguindo<', 
        '>following<',
        'data-testid="unfollow"',
        `data-testid="useractions" data-screenname="${targetLower}"`
      ];
      
      if (followPatterns.some(pattern => profileHtml.includes(pattern))) {
        console.log('✔ indicador “Seguindo” encontrado na página de perfil');
        return true;
      }
    } catch (e) {
      console.log('  • erro na verificação de perfil');
    }

    // 4. Verificação extra no perfil do alvo
    try {
      const targetProfileResp = await axios.get(
        `https://mobile.twitter.com/${TWITTER_TARGET_USER}`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
          },
          timeout: 15000,
        }
      );

      const targetHtml = targetProfileResp.data.toLowerCase();
      
      // Verifica se o usuário aparece na seção de seguidores
      if (
        targetHtml.includes(`href="/${sourceLower}"`) || 
        targetHtml.includes(`>@${sourceLower}<`)
      ) {
        console.log('✔ encontrado no perfil do alvo');
        return true;
      }
    } catch (e) {
      console.log('  • erro na verificação do perfil alvo');
    }

    console.log('✖ nenhum método encontrou follow');
    return false;
  } catch (err) {
    console.error('Erro geral em checkIfUserFollows:', err);
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
    const follows = await checkIfUserFollows(sourceUsername);

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
