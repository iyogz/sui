// Sui Faucet Automation Script
// This script automates:
// 1. Generating a new wallet on Sui faucet
// 2. Solving captchas with Brightdata
// 3. Requesting tokens
// 4. Transferring tokens to a target wallet

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { JsonRpcProvider, Ed25519Keypair, RawSigner } = require('@mysten/sui.js');
const axios = require('axios');

puppeteer.use(StealthPlugin());

// Configuration - REPLACE THESE VALUES
const BRIGHTDATA_API_KEY = 'YOUR_BRIGHTDATA_API_KEY'; 
const TARGET_WALLET_ADDRESS = 'YOUR_TARGET_WALLET_ADDRESS';
const AMOUNT_TO_TRANSFER = 1000000; // Amount in MIST (1 SUI = 1,000,000,000 MIST)

// Brightdata captcha solving function for Cloudflare Turnstile
async function solveCaptcha(sitekey, url) {
  try {
    // Endpoint for Brightdata's captcha solving service
    const response = await axios.post('https://api.brightdata.com/captcha/solve', {
      sitekey: sitekey,
      url: url,
      type: 'turnstile', // Cloudflare Turnstile type
      // Include any additional parameters required by Brightdata for Turnstile
      action: 'faucet_request',
      cdata: window.location.href
    }, {
      headers: {
        'Authorization': `Bearer ${BRIGHTDATA_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (response.data && response.data.solution) {
      console.log('Cloudflare captcha solved successfully');
      return response.data.solution;
    } else {
      throw new Error('Failed to get Cloudflare captcha solution');
    }
  } catch (error) {
    console.error('Error solving Cloudflare captcha:', error.message);
    throw error;
  }
}

// Main automation function
async function automatesuiFaucet() {
  const browser = await puppeteer.launch({
    headless: false, // Set to true for production
    defaultViewport: null,
    args: ['--start-maximized']
  });
  
  try {
    const page = await browser.newPage();
    console.log('Navigating to Sui faucet...');
    await page.goto('https://faucet.sui.io/', { waitUntil: 'networkidle2' });
    
    // Step 1: Generate a new wallet
    console.log('Generating a new wallet...');
    const generateWalletBtn = await page.waitForSelector('button:contains("Generate New Wallet")');
    await generateWalletBtn.click();
    
    // Wait for wallet to be generated and get the address
    await page.waitForSelector('input[value^="0x"]');
    const walletAddress = await page.$eval('input[value^="0x"]', el => el.value);
    console.log(`Generated wallet address: ${walletAddress}`);
    
    // Also capture the mnemonic phrase (important for accessing this wallet later)
    const mnemonic = await page.$eval('.mnemonic-display', el => el.textContent);
    console.log(`Mnemonic phrase: ${mnemonic}`);
    
    // Step 2: Solve Cloudflare Turnstile captcha
    console.log('Locating Cloudflare captcha...');
    // Find the Cloudflare Turnstile element and get its sitekey
    // Wait for the turnstile iframe to be available
    const turnstileFrame = await page.waitForSelector('iframe[src*="challenges.cloudflare.com"]');
    
    // Extract the sitekey from the data-sitekey attribute of the turnstile widget
    const sitekey = await page.evaluate(() => {
      // Look for the turnstile widget container which has the data-sitekey attribute
      const widget = document.querySelector('[data-sitekey]');
      return widget ? widget.getAttribute('data-sitekey') : null;
    });
    
    if (!sitekey) {
      throw new Error('Could not find Cloudflare Turnstile sitekey');
    }
    
    console.log(`Found Cloudflare captcha with sitekey: ${sitekey}`);
    console.log('Solving Cloudflare captcha with Brightdata...');
    const captchaSolution = await solveCaptcha(sitekey, 'https://faucet.sui.io/');
    
    // Input the captcha solution
    await page.evaluate((solution) => {
      // For Cloudflare Turnstile, we need to set the token in the correct field
      // This typically involves finding a hidden input field and setting its value
      const tokenInput = document.querySelector('[name="cf-turnstile-response"]') || 
                         document.querySelector('[name="turnstile-token"]');
                         
      if (tokenInput) {
        tokenInput.value = solution;
      } else {
        // If no direct input field is found, try using the Turnstile API if available
        if (window.turnstile && typeof window.turnstile.execute === 'function') {
          // This is a mock of the token being set via the API
          window.turnstile.execute = () => solution;
        }
      }
      
      // Trigger any validation events if needed
      const event = new Event('turnstile:token-updated', { bubbles: true });
      document.dispatchEvent(event);
    }, captchaSolution);
    
    // Step 3: Request tokens
    console.log('Requesting tokens...');
    const requestTokensBtn = await page.waitForSelector('button:contains("Request Tokens")');
    await requestTokensBtn.click();
    
    // Wait for the success message
    await page.waitForSelector('div:contains("Tokens sent successfully")');
    console.log('Tokens received successfully');
    
    // Step 4: Transfer tokens to target wallet
    console.log(`Setting up to transfer tokens to ${TARGET_WALLET_ADDRESS}...`);
    
    // Create provider and signer using the generated wallet's mnemonic
    const provider = new JsonRpcProvider('https://fullnode.testnet.sui.io');
    
    // Wait a bit for tokens to be confirmed
    console.log('Waiting for tokens to be confirmed on the blockchain...');
    await new Promise(resolve => setTimeout(resolve, 15000));
    
    // Here we would need to convert the mnemonic to a keypair
    // This is a simplified example - actual implementation depends on the wallet format
    const keypair = Ed25519Keypair.deriveKeypair(mnemonic);
    const signer = new RawSigner(keypair, provider);
    
    // Check balance before transfer
    const balance = await provider.getBalance({
      owner: walletAddress,
      coinType: '0x2::sui::SUI'
    });
    console.log(`Current balance: ${balance.totalBalance} MIST`);
    
    if (parseInt(balance.totalBalance) < AMOUNT_TO_TRANSFER) {
      throw new Error('Insufficient balance for transfer');
    }
    
    // Transfer tokens
    console.log(`Transferring ${AMOUNT_TO_TRANSFER} MIST to ${TARGET_WALLET_ADDRESS}...`);
    const tx = await signer.transferSui({
      recipient: TARGET_WALLET_ADDRESS,
      amount: AMOUNT_TO_TRANSFER
    });
    
    console.log('Transfer completed successfully');
    console.log(`Transaction ID: ${tx.digest}`);
    
    return {
      sourceWallet: walletAddress,
      mnemonic: mnemonic,
      targetWallet: TARGET_WALLET_ADDRESS,
      transferAmount: AMOUNT_TO_TRANSFER,
      transactionId: tx.digest
    };
  } catch (error) {
    console.error('Automation failed:', error);
    throw error;
  } finally {
    await browser.close();
  }
}

// Run the automation
// NOTE: Before running this script:
// 1. Install required dependencies:
//    npm install puppeteer-extra puppeteer-extra-plugin-stealth @mysten/sui.js axios
// 2. Fill in your Brightdata API key and target wallet address
// 3. Adjust the transfer amount as needed

automatesuiFaucet()
  .then(result => {
    console.log('Automation completed successfully');
    console.log(result);
  })
  .catch(error => {
    console.error('Automation failed:', error);
  });
