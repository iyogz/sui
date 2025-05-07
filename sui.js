const { Ed25519Keypair, JsonRpcProvider, RawSigner, Connection } = require('@mysten/sui.js');
const axios = require('axios');
const fetch = require('node-fetch');
require('dotenv').config();

const BRIGHTDATA_API_KEY = process.env.BRIGHTDATA_API_KEY;
const TARGET_WALLET = process.env.TARGET_WALLET;
const PROXY = process.env.PROXY;

// Cloudflare Turnstile site key and page URL
const SITE_KEY = '0x4AAAAAAADZTuN1eqQK9IvO';  // Update if changed
const PAGE_URL = 'https://faucet.sui.io';

async function solveCaptcha() {
    const createJobRes = await axios.post('https://api.brightdata.com/turnstile/solve', {
        target: PAGE_URL,
        sitekey: SITE_KEY,
    }, {
        headers: {
            Authorization: `Bearer ${BRIGHTDATA_API_KEY}`,
            'Content-Type': 'application/json',
        }
    });

    const jobId = createJobRes.data.job_id;
    console.log('[+] Captcha job created:', jobId);

    while (true) {
        const statusRes = await axios.get(`https://api.brightdata.com/turnstile/solve/${jobId}`, {
            headers: { Authorization: `Bearer ${BRIGHTDATA_API_KEY}` }
        });

        if (statusRes.data.status === 'solved') {
            console.log('[+] Captcha solved');
            return statusRes.data.solution;
        }

        if (statusRes.data.status === 'failed') throw new Error('Captcha solving failed');
        await new Promise(r => setTimeout(r, 5000));
    }
}

async function requestFaucet(address, captchaToken) {
    const headers = {
        'Content-Type': 'application/json',
    };
    const data = {
        address: address,
        captcha: captchaToken,
    };

    const response = await axios.post('https://faucet.sui.io/api/faucet', data, {
        headers,
        proxy: false,
        httpsAgent: require('https-proxy-agent')(PROXY),
    });

    return response.data;
}

async function transferSUI(signer, recipient) {
    const coins = await signer.provider.getCoins({ owner: await signer.getAddress() });
    const coin = coins.data.find(c => parseFloat(c.balance) >= 1000000000); // 1 SUI = 1e9 MIST

    if (!coin) throw new Error('No coin with enough balance found');

    const tx = await signer.transferObject({
        objectId: coin.coinObjectId,
        gasBudget: 10000000,
        recipient,
    });

    console.log('[+] Transfer TX:', tx.digest);
}

async function mainLoop() {
    const connection = new Connection({
        fullnode: 'https://fullnode.testnet.sui.io:443',
    });
    const provider = new JsonRpcProvider(connection);

    while (true) {
        const keypair = new Ed25519Keypair();
        const signer = new RawSigner(keypair, provider);
        const address = await signer.getAddress();

        console.log('[*] New wallet:', address);

        const captchaToken = await solveCaptcha();
        const faucetResponse = await requestFaucet(address, captchaToken);
        console.log('[+] Faucet response:', faucetResponse);

        console.log('[*] Waiting for tokens to arrive...');
        await new Promise(r => setTimeout(r, 20000));

        try {
            await transferSUI(signer, TARGET_WALLET);
        } catch (e) {
            console.warn('[-] Transfer failed:', e.message);
        }

        console.log('[*] Sleeping before next round...\n');
        await new Promise(r => setTimeout(r, 30000));
    }
}

mainLoop().catch(console.error);
