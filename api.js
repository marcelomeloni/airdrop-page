require('dotenv').config();
const express = require('express');
const { TwitterApi } = require('twitter-api-v2');
const session = require('express-session');
const cors = require('cors');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// 1) Configuração do Twitter (OAuth 1.0a)
const TWITTER_USER_ID = '1916522994236825600';
const CLAIM_ENERGY = 50;
const twitterClient = new TwitterApi({
  appKey: process.env.TWITTER_CONSUMER_KEY,
  appSecret: process.env.TWITTER_CONSUMER_SECRET,
});

// 2) Sessão em memória (desenvolvimento)
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // em produção: secure: true + HTTPS
}));

// 3) CORS
app.use(cors({
  origin: 'http://localhost:5500', // frontend rodando em 5500
  credentials: true
}));

// 4) Body parser para JSON
app.use(bodyParser.json());

// 5) Servir estáticos (pasta public)
app.use(express.static(path.join(__dirname, 'public')));

// 6) “Banco” em memória para guardar tokens de verificação
const claimsDB = new Map();

// 7) Middleware para checar se wallet veio no corpo da requisição
const verifyWallet = (req, res, next) => {
  const walletAddress = req.body.wallet_address || req.params.walletAddress;
  if (!walletAddress) {
    return res.status(400).json({ error: 'Wallet address is required' });
  }
  req.walletAddress = walletAddress;
  next();
};

// 8) Rota que grava a wallet na sessão
app.post('/save-wallet-session', (req, res) => {
  const { walletAddress } = req.body;
  if (!walletAddress) {
    return res.status(400).json({ error: 'Wallet address is required' });
  }
  req.session.walletAddress = walletAddress;
  res.json({ success: true });
});

// 9) Rota para iniciar OAuth no Twitter
app.get('/twitter/auth', async (req, res) => {
  try {
    // Cria link de autenticação (callback será /twitter/callback)
    const callbackUrl = `${process.env.BASE_URL || 'http://localhost:3000'}/twitter/callback`;
    const { url, oauth_token, oauth_token_secret } = await twitterClient.generateAuthLink(callbackUrl);

    // Salva tokens temporários na sessão
    req.session.oauth_token = oauth_token;
    req.session.oauth_token_secret = oauth_token_secret;

    // Redireciona o navegador para o Twitter
    res.redirect(url);
  } catch (error) {
    console.error('Error generating auth link:', error);
    res.status(500).json({ error: 'Failed to start Twitter authentication' });
  }
});

// 10) Callback do Twitter (após o usuário aceitar no Twitter)
app.get('/twitter/callback', async (req, res) => {
  const { oauth_token, oauth_verifier } = req.query;
  const session_oauth_token = req.session.oauth_token;
  const session_oauth_token_secret = req.session.oauth_token_secret;

  // Se não bater com o token que salvamos na sessão, aborta
  if (session_oauth_token !== oauth_token) {
    return res.status(400).send('Invalid token');
  }

  try {
    // Troca o oauth_token + oauth_verifier por um client autenticado
    const tempClient = new TwitterApi({
      appKey: process.env.TWITTER_CONSUMER_KEY,
      appSecret: process.env.TWITTER_CONSUMER_SECRET,
      accessToken: oauth_token,
      accessSecret: session_oauth_token_secret,
    });
    const { client: userClient, accessToken, accessSecret } = await tempClient.login(oauth_verifier);

    // Pega dados do usuário autenticado
    const { data: userData } = await userClient.v2.me({
      'user.fields': ['id', 'name', 'username']
    });

    // Verifica se o usuário segue a conta @sunaryum
    const follows = await checkIfUserFollows(userClient, userData.id, TWITTER_USER_ID);

    // Gera token único de verificação
    const verificationToken = uuidv4();
    claimsDB.set(verificationToken, {
      userId: userData.id,
      screenName: userData.username,
      follows,
      walletAddress: req.session.walletAddress,
      verifiedAt: new Date(),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000)
    });

    // Informa ao frontend, via postMessage no popup, que deu certo
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Twitter Auth</title>
        <script>
          window.opener.postMessage({
            type: 'TWITTER_AUTH_COMPLETE',
            success: true,
            token: '${verificationToken}'
          }, '*');
          window.close();
        </script>
      </head>
      <body>
        Authentication successful! You can close this window.
      </body>
      </html>
    `);
  } catch (error) {
    console.error('Error during callback:', error);
    res.status(500).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Twitter Auth</title>
        <script>
          window.opener.postMessage({
            type: 'TWITTER_AUTH_COMPLETE',
            success: false,
            error: 'Authentication failed'
          }, '*');
          window.close();
        </script>
      </head>
      <body>
        Authentication failed. Please try again.
      </body>
      </html>
    `);
  }
});

// 11) Função auxiliar para checar “follow”
async function checkIfUserFollows(client, sourceUserId, targetUserId) {
  try {
    // Caso o usuário siga muita gente, pode precisar paginar:
    let paginationToken = undefined;
    do {
      const response = await client.v2.following(sourceUserId, {
        max_results: 1000,
        pagination_token: paginationToken,
        'user.fields': ['id']
      });
      if (response.data.some(u => u.id === targetUserId)) {
        return true;
      }
      paginationToken = response.meta.next_token;
    } while (paginationToken);

    return false;
  } catch (error) {
    console.error('Error checking follow status:', error);
    return false;
  }
}

// 12) Verificação após o popup avisar que o usuário fez login
app.post('/twitter/verify-follow', verifyWallet, (req, res) => {
  const { token } = req.body;
  const walletAddress = req.walletAddress;

  if (!token) {
    return res.status(400).json({ verified: false, error: 'Verification token is required' });
  }
  const verificationData = claimsDB.get(token);
  if (!verificationData) {
    return res.json({ verified: false, error: 'Invalid or expired token' });
  }
  if (verificationData.walletAddress !== walletAddress) {
    return res.json({ verified: false, error: 'Token does not match wallet' });
  }
  if (new Date() > verificationData.expiresAt) {
    claimsDB.delete(token);
    return res.json({ verified: false, error: 'Verification token expired' });
  }

  res.json({
    verified: verificationData.follows,
    twitterHandle: verificationData.screenName
  });
});

// 13) Rota para “claim” de recompensa
app.post('/claim-reward', verifyWallet, (req, res) => {
  const { token } = req.body;
  const walletAddress = req.walletAddress;
  if (!token) {
    return res.status(400).json({ success: false, error: 'Verification token is required' });
  }
  const verificationData = claimsDB.get(token);
  if (!verificationData) {
    return res.json({ success: false, error: 'Invalid or expired token' });
  }
  if (verificationData.walletAddress !== walletAddress) {
    return res.json({ success: false, error: 'Token does not match wallet' });
  }
  if (new Date() > verificationData.expiresAt) {
    claimsDB.delete(token);
    return res.json({ success: false, error: 'Verification token expired' });
  }
  if (!verificationData.follows) {
    return res.json({ success: false, error: 'You do not follow @sunaryum on Twitter' });
  }
  if (verificationData.claimed) {
    return res.json({ success: false, error: 'Reward already claimed for this verification' });
  }

  verificationData.claimed = true;
  verificationData.claimedAt = new Date();
  claimsDB.set(token, verificationData);

  console.log(`Claiming reward for ${walletAddress} (${verificationData.screenName}): ${CLAIM_ENERGY} energy`);
  res.json({
    success: true,
    message: `Successfully claimed ${CLAIM_ENERGY} energy`,
    energy: CLAIM_ENERGY,
    twitterHandle: verificationData.screenName
  });
});

// 14) Rota para checar status de “claims” de uma wallet
app.get('/claim-status/:walletAddress', (req, res) => {
  const walletAddress = req.params.walletAddress;
  const claims = [];
  for (const [token, data] of claimsDB) {
    if (data.walletAddress === walletAddress) {
      claims.push({
        twitterHandle: data.screenName,
        claimed: data.claimed || false,
        claimedAt: data.claimedAt,
        verifiedAt: data.verifiedAt
      });
    }
  }
  res.json({ claims });
});

// 15) Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    twitterUserId: TWITTER_USER_ID,
    claimsCount: claimsDB.size
  });
});


// 17) Inicia o servidor
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Frontend: http://localhost:${PORT}`);
  console.log(`Twitter verification for user ID: ${TWITTER_USER_ID}`);
});
