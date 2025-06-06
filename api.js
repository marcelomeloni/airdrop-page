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
const TWITTER_TARGET_USER = 'sunaryum'; // Nome de usuário do alvo
const CLAIM_ENERGY = 50;

// Configuração do cliente do Twitter
const twitterClient = new TwitterApi({
  appKey: process.env.TWITTER_CONSUMER_KEY,
  appSecret: process.env.TWITTER_CONSUMER_SECRET,
});

// Configurações do Express
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

// Banco de dados em memória (sem persistência)
const claimsDB = new Map();

// Middleware para verificar wallet address
const verifyWallet = (req, res, next) => {
  const walletAddress = req.body.wallet_address || req.params.walletAddress;
  if (!walletAddress) {
    return res.status(400).json({ error: 'Wallet address is required' });
  }
  req.walletAddress = walletAddress;
  next();
};

// Salva wallet na sessão
app.post('/save-wallet-session', (req, res) => {
  const { walletAddress } = req.body;
  if (!walletAddress) {
    return res.status(400).json({ error: 'Wallet address is required' });
  }
  req.session.walletAddress = walletAddress;
  res.json({ success: true });
});

// Inicia autenticação no Twitter
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
    res.status(500).json({ error: 'Falha ao iniciar autenticação no Twitter' });
  }
});

// ====================================================
// VERIFICAÇÃO DE FOLLOW VIA SCRAPING LEVE (FUNCIONA COM PLANO FREE)
// ====================================================
// ====================================================
// VERIFICAÇÃO DE FOLLOW VIA SCRAPING AVANÇADO
// ====================================================
async function checkIfUserFollows(sourceUsername) {
  try {
    console.log(`Iniciando verificação de follow para @${sourceUsername}`);
    
    // 1. Verificação pela página de seguidores do alvo
    try {
      const followersResponse = await axios.get(`https://twitter.com/${TWITTER_TARGET_USER}/followers`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7'
        },
        timeout: 20000
      });
      
      // Verificar se o usuário está na lista de seguidores do alvo
      if (followersResponse.data.includes(`href="/${sourceUsername}"`)) {
        console.log(`Encontrado na lista de seguidores de @${TWITTER_TARGET_USER}`);
        return true;
      }
    } catch (error) {
      console.log('Erro ao acessar lista de seguidores, tentando alternativa...');
    }

    // 2. Verificação direta da relação
    try {
      const relationshipUrl = `https://twitter.com/i/api/1.1/friendships/show.json?source_screen_name=${sourceUsername}&target_screen_name=${TWITTER_TARGET_USER}`;
      const relationshipResponse = await axios.get(relationshipUrl, {
        headers: {
          'Authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          'x-twitter-active-user': 'yes',
          'x-twitter-client-language': 'pt'
        },
        timeout: 15000
      });

      if (relationshipResponse.data?.relationship?.source?.following) {
        console.log('Relação de follow encontrada via API interna');
        return true;
      }
    } catch (error) {
      console.log('Falha na verificação direta, tentando scraping...');
    }

    // 3. Scraping avançado da página de seguindo
    try {
      const followingResponse = await axios.get(`https://twitter.com/${sourceUsername}/following`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
          'Cookie': 'lang=pt'
        },
        timeout: 20000
      });
      
      // Busca avançada por elementos específicos
      const regex = new RegExp(
        `data-testid="UserCell".*?href="/${TWITTER_TARGET_USER}"|` +
        `href="/${TWITTER_TARGET_USER}"[^>]*aria-label[^>]*>@${TWITTER_TARGET_USER}<|` +
        `data-testid="UserCell".*?@${TWITTER_TARGET_USER}`,
        's'
      );
      
      if (regex.test(followingResponse.data)) {
        console.log('Elemento específico encontrado na página de seguindo');
        return true;
      }
    } catch (error) {
      console.log('Erro no scraping da página de seguindo');
    }

    // 4. Último recurso: verificação na página do perfil
    try {
      const profileResponse = await axios.get(`https://twitter.com/${sourceUsername}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7'
        },
        timeout: 15000
      });
      
      // Verificar por múltiplos indicadores
     const indicators = [
  `data-testid="userFollowIndicator"`,
  `Segue @${TWITTER_TARGET_USER}`,
  `Following @${TWITTER_TARGET_USER}`,
  `aria-label="Segue @${TWITTER_TARGET_USER}"`,
  `>${TWITTER_TARGET_USER}<`, // Para detectar menções diretas no HTML
  '>Seguindo<', // <- ADICIONADO baseado no seu trecho do Inspect
  '>Following<' // <- Para compatibilidade com Twitter em inglês
];
      
      for (const indicator of indicators) {
        if (profileResponse.data.includes(indicator)) {
          console.log(`Indicador encontrado: ${indicator}`);
          return true;
        }
      }
    } catch (error) {
      console.log('Erro na verificação do perfil');
    }
    
    console.log('Nenhum método encontrou a relação de follow');
    return false;
    
  } catch (error) {
    console.error('Erro geral na verificação de follow:', error.message);
    return false;
  }
}

// ====================================================
// CALLBACK - PROCESSAMENTO APÓS AUTENTICAÇÃO
// ====================================================
app.get('/twitter/callback', async (req, res) => {
  const { oauth_token, oauth_verifier } = req.query;
  const session_oauth_token = req.session.oauth_token;
  const session_oauth_token_secret = req.session.oauth_token_secret;

  if (session_oauth_token !== oauth_token) {
    return res.status(400).send('Token inválido');
  }

  try {
    const tempClient = new TwitterApi({
      appKey: process.env.TWITTER_CONSUMER_KEY,
      appSecret: process.env.TWITTER_CONSUMER_SECRET,
      accessToken: oauth_token,
      accessSecret: session_oauth_token_secret,
    });
    
    const { client: userClient } = await tempClient.login(oauth_verifier);

    // Obtém dados do usuário (usando apenas endpoints básicos)
    const { data: userData } = await userClient.v2.me({
      'user.fields': ['id', 'username'],
    });

    // Verifica se segue a conta alvo usando scraping
    const follows = await checkIfUserFollows(userData.username);

    // Cria token de verificação
    const verificationToken = uuidv4();
    claimsDB.set(verificationToken, {
      userId: userData.id,
      screenName: userData.username,
      follows,
      walletAddress: req.session.walletAddress,
      verifiedAt: new Date(),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 minutos de validade
    });

    // Fecha a janela de autenticação
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Autenticação Twitter</title>
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
        Autenticação bem-sucedida! Esta janela pode ser fechada.
      </body>
      </html>
    `);
  } catch (error) {
    console.error('Erro no callback:', error);
    res.status(500).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Erro de Autenticação</title>
        <script>
          window.opener.postMessage({
            type: 'TWITTER_AUTH_COMPLETE',
            success: false,
            error: 'Falha na autenticação'
          }, '*');
          window.close();
        </script>
      </head>
      <body>Erro na autenticação. Por favor, tente novamente.</body>
      </html>
    `);
  }
});

// ====================================================
// ROTAS DE VERIFICAÇÃO E RECOMPENSA
// ====================================================

// Verifica se o usuário segue
app.post('/twitter/verify-follow', verifyWallet, (req, res) => {
  const { token } = req.body;
  const walletAddress = req.walletAddress;
  
  if (!token) {
    return res.status(400).json({ 
      verified: false, 
      error: 'Token de verificação é obrigatório' 
    });
  }
  
  const verificationData = claimsDB.get(token);
  
  // Validações
  if (!verificationData) {
    return res.json({ 
      verified: false, 
      error: 'Token inválido ou expirado' 
    });
  }
  
  if (verificationData.walletAddress !== walletAddress) {
    return res.json({ 
      verified: false, 
      error: 'Token não corresponde à wallet' 
    });
  }
  
  if (new Date() > verificationData.expiresAt) {
    claimsDB.delete(token);
    return res.json({ 
      verified: false, 
      error: 'Token expirado' 
    });
  }

  res.json({
    verified: verificationData.follows,
    twitterHandle: verificationData.screenName,
  });
});

// Reivindicação de recompensa
app.post('/claim-reward', verifyWallet, (req, res) => {
  const { token } = req.body;
  const walletAddress = req.walletAddress;
  
  if (!token) {
    return res.status(400).json({ 
      success: false, 
      error: 'Token de verificação é obrigatório' 
    });
  }
  
  const verificationData = claimsDB.get(token);
  
  // Validações
  if (!verificationData) {
    return res.json({ 
      success: false, 
      error: 'Token inválido ou expirado' 
    });
  }
  
  if (verificationData.walletAddress !== walletAddress) {
    return res.json({ 
      success: false, 
      error: 'Token não corresponde à wallet' 
    });
  }
  
  if (new Date() > verificationData.expiresAt) {
    claimsDB.delete(token);
    return res.json({ 
      success: false, 
      error: 'Token expirado' 
    });
  }
  
  if (!verificationData.follows) {
    return res.json({
      success: false,
      error: 'Você não segue @sunaryum no Twitter'
    });
  }
  
  if (verificationData.claimed) {
    return res.json({
      success: false,
      error: 'Recompensa já reivindicada para esta verificação'
    });
  }

  // Marca como reivindicado
  verificationData.claimed = true;
  verificationData.claimedAt = new Date();
  claimsDB.set(token, verificationData);

  console.log(
    `Recompensa reivindicada para ${walletAddress} (${verificationData.screenName}): ${CLAIM_ENERGY} pontos`
  );
  
  res.json({
    success: true,
    message: `Recompensa de ${CLAIM_ENERGY} pontos reivindicada com sucesso!`,
    energy: CLAIM_ENERGY,
    twitterHandle: verificationData.screenName,
  });
});

// Rota de status (opcional)
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

// Rota de airdrop
app.get('/airdrop', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'test.html'));
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'online',
    claimsCount: claimsDB.size,
    uptime: process.uptime()
  });
});

// Inicialização do servidor
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Frontend: http://localhost:${PORT}`);
  console.log(`Verificando follows para: @${TWITTER_TARGET_USER}`);
});
