document.addEventListener('DOMContentLoaded', () => {
    const connectBtn = document.getElementById('connectWalletBtn');
    const walletAddress = document.getElementById('walletAddress');

    let currentWallet = null;
    let socialStatus = { twitter: false, instagram: false };
    let claimStatus = { twitter: false, instagram: false };
    let twitterVerificationToken = null;

    // Elementos do dropdown
    const dropdownHeader = document.querySelector('.dropdown-header');
    const questsList = document.querySelector('.quests-list');
    const chevron = dropdownHeader?.querySelector('.fa-chevron-down');

    // Dropdown toggle
    if (dropdownHeader && questsList && chevron) {
        dropdownHeader.addEventListener('click', () => {
            questsList.classList.toggle('open');
            chevron.classList.toggle('rotate');
        });
    }

    // Gerenciamento de estado local
    function loadState() {
        if (!currentWallet?.address) return;
        
        try {
            const savedSocialStatus = localStorage.getItem(`socialStatus_${currentWallet.address}`);
            const savedClaimStatus = localStorage.getItem(`claimStatus_${currentWallet.address}`);
            
            socialStatus = JSON.parse(savedSocialStatus) || { twitter: false, instagram: false };
            claimStatus = JSON.parse(savedClaimStatus) || { twitter: false, instagram: false };
        } catch (error) {
            console.error('Error loading state:', error);
        }
    }

    function saveState() {
        if (!currentWallet?.address) return;
        try {
            localStorage.setItem(`socialStatus_${currentWallet.address}`, JSON.stringify(socialStatus));
            localStorage.setItem(`claimStatus_${currentWallet.address}`, JSON.stringify(claimStatus));
        } catch (error) {
            console.error('Error saving state:', error);
        }
    }

    // Conexão da Wallet
    function setupWalletConnection() {
        if (connectBtn) {
            connectBtn.addEventListener('click', () => {
                window.postMessage({ 
                    type: 'OPEN_WALLET_CONNECT',
                    origin: window.location.origin 
                }, '*');
            });
        }

        window.addEventListener('message', (event) => {
            if (event.data.type === 'WALLET_CONNECTED') {
                handleWalletConnect(event.data.data);
            }
        });
    }

    // Handler de conexão da wallet
    function handleWalletConnect(data) {
        if (!data?.address) return;
        
        currentWallet = data;
        loadState();
        
        // Atualiza UI
        const shortAddress = `${data.address.slice(0, 6)}...${data.address.slice(-4)}`;
        walletAddress.textContent = shortAddress;
        walletAddress.style.display = 'block';
        connectBtn.innerHTML = `<i class="fas fa-check"></i> Connected`;
        connectBtn.disabled = true;

        // Atualiza estados
        updateClaimButtons();
    }

    // Handler para resultado da autenticação do Twitter
    window.addEventListener('message', async (event) => {
        if (event.data.type === 'TWITTER_AUTH_COMPLETE' && event.data.success) {
            const token = event.data.token;
            await checkTwitterVerification(token);
        }
    });

    // Função para verificar follow no Twitter
    async function verifyTwitterFollow() {
        if (!currentWallet) {
            alert("Connect your wallet first!");
            return;
        }

        const verifyBtn = document.getElementById('verifyTwitterBtn');
        verifyBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Verifying...';
        verifyBtn.disabled = true;

        try {
            // Salva o endereço da carteira na sessão do backend (URL RELATIVA)
            await fetch('/save-wallet-session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ walletAddress: currentWallet.address })
            });

            // Abre janela de autenticação (URL RELATIVA)
            const authWindow = window.open(
                '/twitter/auth',
                'twitter_auth',
                'width=600,height=700'
            );

            // Verifica se popup foi bloqueado
            if (!authWindow) {
                alert("Please allow popups to complete verification");
                throw new Error('Popup blocked');
            }

        } catch (error) {
            console.error('Auth error:', error);
            verifyBtn.innerHTML = 'Verify';
            verifyBtn.disabled = false;
            
            // Mensagem mais amigável para o usuário
            alert(`Failed to start verification: ${error.message || 'Please check your connection'}`);
        }
    }
      
    // Verificação após autenticação
    async function checkTwitterVerification(token) {
        const verifyBtn = document.getElementById('verifyTwitterBtn');
        
        try {
            // URL RELATIVA para verificação
            const response = await fetch('/twitter/verify-follow', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    wallet_address: currentWallet.address,
                    token: token
                })
            });
            
            const result = await response.json();
            
            if (result.verified) {
                socialStatus.twitter = true;
                twitterVerificationToken = token;
                saveState();
                updateClaimButtons();
                alert("Successfully verified! You follow @sunaryum.");
            } else {
                alert(`Verification failed: ${result.error || "You don't follow @sunaryum"}`);
            }
        } catch (error) {
            console.error('Verification error:', error);
            alert("Verification failed. Please try again.");
        } finally {
            verifyBtn.innerHTML = 'Verify';
            verifyBtn.disabled = false;
        }
    }

    // Listener para botão de verificação
    document.getElementById('verifyTwitterBtn').addEventListener('click', verifyTwitterFollow);

    // Sistema de Claims
    async function sendClaimTransaction(platform) {
        // Para Twitter, usamos o token de verificação
        if (platform === 'twitter') {
            if (!twitterVerificationToken) {
                alert("Twitter verification token is missing. Please verify again.");
                return false;
            }

            try {
                // URL RELATIVA para claim
                const response = await fetch('/claim-reward', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        wallet_address: currentWallet.address,
                        token: twitterVerificationToken
                    })
                });
                
                const result = await response.json();
                
                if (result.success) {
                    return true;
                } else {
                    throw new Error(result.error || 'Claim failed');
                }
                
            } catch (err) {
                console.error('Twitter claim error:', err);
                alert('Error: ' + err.message);
                return false;
            }
        }
        
        // Para outras plataformas (Instagram), mantemos o método original
        try {
            // URL ABSOLUTA para o serviço externo
            const response = await fetch('https://airdrop-sunaryum.onrender.com/node/report_energy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    wallet_address: currentWallet.address,
                    public_key: currentWallet.public_key || "",
                    energy: 50,
                    quest: platform
                }),
            });

            if (!response.ok) throw new Error('Network response was not ok');
            
            const result = await response.json();
            return result.status === 'success';
            
        } catch (err) {
            console.error('Claim error:', err);
            alert('Error: ' + err.message);
            return false;
        }
    }

    // Atualização dos botões de claim
    function updateClaimButtons() {
        if (!currentWallet) return;

        document.querySelectorAll('.quest-item').forEach(item => {
            const platform = item.querySelector('.social-link')?.dataset.platform;
            const btn = item.querySelector('.claim-btn');
            if (!platform || !btn) return;

            const canClaim = socialStatus[platform] && !claimStatus[platform];
            
            btn.classList.toggle('active', canClaim);
            btn.disabled = !canClaim;

            btn.innerHTML = canClaim 
                ? '<span>Claim 50 $SUN</span>'
                : claimStatus[platform] 
                    ? '<i class="fas fa-check"></i> Claimed!'
                    : '<span>Claim</span><i class="fas fa-lock"></i>';

            btn.style.cssText = claimStatus[platform] 
                ? 'background-color: #e0e0e0; color: #4CAF50; cursor: not-allowed;'
                : socialStatus[platform] 
                    ? 'cursor: pointer; background-color: #4CAF50; color: white;'
                    : 'cursor: default; background-color: #f0f0f0;';
        });
    }

    // Event Handlers
    function setupEventListeners() {
        // Social Links
        document.querySelectorAll('.social-link').forEach(link => {
            link.addEventListener('click', function(e) {
                if (e.target.tagName === 'A' && currentWallet) {
                    const platform = this.dataset.platform;
                    platform && setTimeout(() => {
                        socialStatus[platform] = true;
                        saveState();
                        updateClaimButtons();
                    }, 1000);
                }
            });
        });

        // Claim Buttons
        document.addEventListener('click', async (e) => {
            const btn = e.target.closest('.claim-btn.active');
            if (!btn || !currentWallet) return;

            const platform = btn.closest('.quest-item')?.querySelector('.social-link')?.dataset.platform;
            if (!platform) return;

            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';

            try {
                const success = await sendClaimTransaction(platform);
                if (success) {
                    claimStatus[platform] = true;
                    saveState();
                } else {
                    alert('Claim failed. Please try again.');
                }
            } catch (error) {
                console.error('Claim error:', error);
                alert('Error: ' + error.message);
            } finally {
                updateClaimButtons();
            }
        });
    }

    // Inicialização
    setupWalletConnection();
    setupEventListeners();
    updateClaimButtons();
});

// Content Script da Extensão
if (typeof browser !== 'undefined') {
    window.addEventListener('message', (event) => {
        if (event.data.type === 'OPEN_WALLET_CONNECT') {
            browser.runtime.sendMessage({
                action: "openConnectWindow",
                origin: event.data.origin
            });
        }
    });

    browser.runtime.onMessage.addListener((msg) => {
        if (msg.action === "walletDataUpdate") {
            window.postMessage({
                type: 'WALLET_CONNECTED',
                data: msg.data
            }, '*');
        }
    });
}