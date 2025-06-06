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
const TWITTER_USER_ID = '1916522994236825600';
const CLAIM_ENERGY = 50;

const twitterClient = new TwitterApi({
  appKey: process.env.TWITTER_CONSUMER_KEY,
  appSecret: process.env.TWITTER_CONSUMER_SECRET,
});

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'your-secret-key',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false },
  })
);

app.use(
  cors({
    origin: 'https://airdrop-page.onrender.com',
    credentials: true,
  })
);

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

const claimsDB = new Map();

const verifyWallet = (req, res, next) => {
  const walletAddress = req.body.wallet_address || req.params.walletAddress;
  if (!walletAddress) {
    return res.status(400).json({ error: 'Wallet address is required' });
  }
  req.walletAddress = walletAddress;
  next();
};

app.post('/save-wallet-session', (req, res) => {
  const { walletAddress } = req.body;
  if (!walletAddress) {
    return res.status(400).json({ error: 'Wallet address is required' });
  }
  req.session.walletAddress = walletAddress;
  res.json({ success: true });
});

app.get('/twitter/auth', async (req, res) => {
  try {
    const callbackUrl = 'https://airdrop-page.onrender.com/twitter/callback';
    const { url, oauth_token, oauth_token_secret } =
      await twitterClient.generateAuthLink(callbackUrl);

    req.session.oauth_token = oauth_token;
    req.session.oauth_token_secret = oauth_token_secret;
    res.redirect(url);
  } catch (error) {
    console.error('Erro no OAuth:', error);
    res
      .status(500)
      .json({ error: 'Falha ao iniciar autenticação no Twitter' });
  }
});

// ——————————————————————————————————
// Nova função corrigida: chama GET /2/users/:source/following/:target
// ——————————————————————————————————
async function checkIfUserFollowsV2ViaListing(client, sourceUserId, targetUserId) {
  try {
    let paginationToken = undefined;

    do {
      // Lista até 1000 IDs de quem sourceUserId segue, por página:
      const resp = await client.v2.following(sourceUserId, {
        asPaginator: false,     // false é padrão; recebe data + meta
        max_results: 1000,
        pagination_token: paginationToken,
        'user.fields': ['id'],  // só precisamos do id para comparar
      });

      // resp.data é array de objetos { id, name?, username? } 
      if (resp.data.some(u => u.id === targetUserId)) {
        // Achou targetUserId na página → segue
        return true;
      }

      // Avança para próxima página (se existir)
      paginationToken = resp.meta.next_token;
    } while (paginationToken);

    // Passou por todas as páginas e não achou → não segue
    return false;
  } catch (err) {
    console.error('Erro checando follow via listagem V2:', err);
    return false;
  }
}

// ——————————————————————————————————
// Callback após o usuário autenticar no Twitter
// ——————————————————————————————————
app.get('/twitter/callback', async (req, res) => {
  const { oauth_token, oauth_verifier } = req.query;
  const session_oauth_token = req.session.oauth_token;
  const session_oauth_token_secret = req.session.oauth_token_secret;

  if (session_oauth_token !== oauth_token) {
    return res.status(400).send('Invalid token');
  }

  try {
    const tempClient = new TwitterApi({
      appKey: process.env.TWITTER_CONSUMER_KEY,
      appSecret: process.env.TWITTER_CONSUMER_SECRET,
      accessToken: oauth_token,
      accessSecret: session_oauth_token_secret,
    });
    const { client: userClient } = await tempClient.login(oauth_verifier);

    // Pega o próprio ID do usuário logado
    const { data: userData } = await userClient.v2.me({
      'user.fields': ['id', 'username'],
    });

    // Usa a listagem paginada para checar se segue @sunaryum:
    const follows = await checkIfUserFollowsV2ViaListing(
      userClient,
      userData.id,
      TWITTER_USER_ID
    );

    // Gera token de verificação e guarda no “DB” em memória
    const verificationToken = uuidv4();
    claimsDB.set(verificationToken, {
      userId: userData.id,
      screenName: userData.username,
      follows,                          // true ou false
      walletAddress: req.session.walletAddress,
      verifiedAt: new Date(),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    });

    // Retorna HTML que executa postMessage() no popup:
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
      <head><title>Twitter Auth</title>
        <script>
          window.opener.postMessage({
            type: 'TWITTER_AUTH_COMPLETE',
            success: false,
            error: 'Authentication failed'
          }, '*');
          window.close();
        </script>
      </head>
      <body>Authentication failed. Please try again.</body>
      </html>
    `);
  }
});


// ——————————————————————————————————
// Verificação depois que o popup notifica o front que o usuário autenticou
// ——————————————————————————————————
app.post('/twitter/verify-follow', verifyWallet, (req, res) => {
  const { token } = req.body;
  const walletAddress = req.walletAddress;
  if (!token) {
    return res
      .status(400)
      .json({ verified: false, error: 'Verification token is required' });
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
    twitterHandle: verificationData.screenName,
  });
});

// ——————————————————————————————————
// Rota para “claim” de recompensa
// ——————————————————————————————————
app.post('/claim-reward', verifyWallet, (req, res) => {
  const { token } = req.body;
  const walletAddress = req.walletAddress;
  if (!token) {
    return res
      .status(400)
      .json({ success: false, error: 'Verification token is required' });
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
    return res.json({
      success: false,
      error: 'You do not follow @sunaryum on Twitter',
    });
  }
  if (verificationData.claimed) {
    return res.json({
      success: false,
      error: 'Reward already claimed for this verification',
    });
  }

  verificationData.claimed = true;
  verificationData.claimedAt = new Date();
  claimsDB.set(token, verificationData);

  console.log(
    `Claiming reward for ${walletAddress} (${verificationData.screenName}): ${CLAIM_ENERGY} energy`
  );
  res.json({
    success: true,
    message: `Successfully claimed ${CLAIM_ENERGY} energy`,
    energy: CLAIM_ENERGY,
    twitterHandle: verificationData.screenName,
  });
});

// ——————————————————————————————————
// Rota para checar status de “claims” de uma wallet
// ——————————————————————————————————
app.get('/claim-status/:walletAddress', (req, res) => {
  const walletAddress = req.params.walletAddress;
  const claims = [];
  for (const [token, data] of claimsDB) {
    if (data.walletAddress === walletAddress) {
      claims.push({
        twitterHandle: data.screenName,
        claimed: data.claimed || false,
        claimedAt: data.claimedAt,
        verifiedAt: data.verifiedAt,
      });
    }
  }
  res.json({ claims });
});

// ——————————————————————————————————
// Rota customizada /airdrop
// ——————————————————————————————————
app.get('/airdrop', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'test.html'));
});

// ——————————————————————————————————
// Health check
// ——————————————————————————————————
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    twitterUserId: TWITTER_USER_ID,
    claimsCount: claimsDB.size,
  });
});

// ——————————————————————————————————
// Inicia o servidor
// ——————————————————————————————————
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Frontend: http://localhost:${PORT}`);
  console.log(`Twitter verification for user ID: ${TWITTER_USER_ID}`);
});
