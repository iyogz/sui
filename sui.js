// Sui Wallet Generation and Faucet Script
// This uses ESM modules, save as sui-wallet-faucet.mjs and run with: node sui-wallet-faucet.mjs

import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import axios from 'axios';
import fs from 'fs/promises';
import { Ed25519Keypair } from '@mysten/sui.js/keypairs/ed25519';
import { getFaucetHost, requestSuiFromFaucetV0 } from '@mysten/sui.js/faucet';
import { SuiClient } from '@mysten/sui.js/client';

// Apply stealth plugin to puppeteer
puppeteer.use(StealthPlugin());

// Configuration - REPLACE THESE VALUES
const BRIGHTDATA_API_KEY = 'YOUR_BRIGHTDATA_API_KEY'; 
const TARGET_WALLET_ADDRESS = 'YOUR_TARGET_WALLET_ADDRESS';

// Create a new Sui wallet using SUI.js
async function createSuiWallet() {
  try {
    // Generate a new Ed25519 keypair
    const keypair = new Ed25519Keypair();
    
    // Get the address from the keypair
    const address = keypair.getPublicKey().toSuiAddress();
    
    // Get the private key and export the keypair
    const privateKey = Buffer.from(keypair.export().privateKey).toString('hex');
    
    console.log('Generated new Sui wallet:');
    console.log(`Address: ${address}`);
    console.log(`Private Key: ${privateKey}`);
    
    return { address, privateKey, keypair };
  } catch (error) {
    console.error('Error creating wallet:', error);
    throw error;
  }
}

// Programmatic attempt to request from faucet using SUI.js
async function requestTokensFromFaucetAPI(address) {
  try {
    console.log(`Requesting tokens from Sui faucet API for ${address}...`);
    
    // Get the faucet host for the testnet
    const faucetHost = getFaucetHost('testnet');
    
    // Request tokens from the faucet
    const response = await requestSuiFromFaucetV0({
      host: faucetHost,
      recipient: address,
    });
    
    console.log('Faucet API response:', response);
    return response;
  } catch (error) {
    console.error('Error requesting tokens from faucet API:', error);
    console.log('Will try browser automation as fallback...');
    return null;
  }
}

// Browser automation for faucet as a fallback
async function requestTokensFromFaucetBrowser(address) {
  const browser = await puppeteer.launch({
    headless: false, // Change to true for production
    defaultViewport: null,
    args: ['--start-maximized']
  });
  
  try {
    const page = await browser.newPage();
    console.log('Navigating to Sui faucet...');
    await page.goto('https://faucet.sui.io/', { waitUntil: 'networkidle2' });
    
    // Enter the wallet address
    const addressInput = await page.waitForSelector('input[placeholder="Wallet Address"]');
    await addressInput.click({ clickCount: 3 }); // Select all text (if any)
    await addressInput.type(address);
    
    // Step 2: Solve Cloudflare Turnstile captcha
    console.log('Locating Cloudflare captcha...');
    
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
    
    // Solve the captcha using Brightdata
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
    
    // Request tokens
    console.log('Requesting tokens...');
    const requestTokensBtn = await page.waitForSelector('button:contains("Request Tokens")');
    await requestTokensBtn.click();
    
    // Wait for the success message
    await page.waitForSelector('div:contains("Tokens sent successfully")', { timeout: 30000 });
    console.log('Tokens received successfully via browser');
    
    return true;
  } catch (error) {
    console.error('Error in browser automation:', error);
    throw error;
  } finally {
    await browser.close();
  }
}

// Brightdata captcha solving function for Cloudflare Turnstile
async function solveCaptcha(sitekey, url) {
  try {
    // Endpoint for Brightdata's captcha solving service
    const response = await axios.post('https://api.brightdata.com/captcha/solve', {
      sitekey: sitekey,
      url: url,
      type: 'turnstile', // Cloudflare Turnstile type
      action: 'faucet_request',
      cdata: url
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

// Transfer tokens to target wallet
async function transferTokens(fromKeypair, toAddress, amount) {
  try {
    console.log(`Setting up to transfer tokens to ${toAddress}...`);
    
    // Create a Sui client connected to the testnet
    const client = new SuiClient({ url: 'https://fullnode.testnet.sui.io' });
    
    // Wait a bit for tokens to be confirmed
    console.log('Waiting for tokens to be confirmed on the blockchain...');
    await new Promise(resolve => setTimeout(resolve, 15000));
    
    // Get the coin objects owned by the address
    const address = fromKeypair.getPublicKey().toSuiAddress();
    const coins = await client.getCoins({
      owner: address,
    });
    
    if (!coins || coins.data.length === 0) {
      throw new Error('No coins found in the wallet');
    }
    
    console.log(`Found ${coins.data.length} coins in the wallet`);
    
    // Get total balance
    let totalBalance = 0;
    for (const coin of coins.data) {
      totalBalance += Number(coin.balance);
    }
    
    console.log(`Total balance: ${totalBalance} MIST`);
    
    // Check if we have enough balance
    if (totalBalance < amount) {
      throw new Error(`Insufficient balance (${totalBalance}) for transfer of ${amount}`);
    }
    
    // Create and execute the transaction
    // This part depends on the specific SUI.js version and methods
    // Using TransactionBlock from the latest SUI.js
    const { TransactionBlock } = await import('@mysten/sui.js/transactions');
    
    const tx = new TransactionBlock();
    const [coin] = tx.splitCoins(tx.gas, [tx.pure(amount)]);
    tx.transferObjects([coin], tx.pure(toAddress));
    
    // Sign and execute the transaction
    const result = await client.signAndExecuteTransactionBlock({
      transactionBlock: tx,
      signer: fromKeypair,
    });

    console.log('Transfer completed successfully');
    console.log(`Transaction ID: ${result.digest}`);
    
    return result;
  } catch (error) {
    console.error('Error transferring tokens:', error);
    throw error;
  }
}

// Main function
async function main() {
  try {
    // Step 1: Create a new Sui wallet
    const wallet = await createSuiWallet();
    
    // Save wallet info to file
    await fs.writeFile('wallet_info.json', JSON.stringify({
      address: wallet.address,
      privateKey: wallet.privateKey,
      targetAddress: TARGET_WALLET_ADDRESS,
      date: new Date().toISOString()
    }, null, 2));
    
    console.log('Wallet information saved to wallet_info.json');
    
    // Step 2: Request tokens from faucet
    // First try the API method
    let faucetSuccess = await requestTokensFromFaucetAPI(wallet.address);
    
    // If API method fails, try browser automation
    if (!faucetSuccess) {
      faucetSuccess = await requestTokensFromFaucetBrowser(wallet.address);
    }
    
    if (!faucetSuccess) {
      throw new Error('Failed to get tokens from faucet');
    }
    
    // Step 3: Transfer tokens to target wallet
    // Define amount to transfer (in MIST)
    const transferAmount = 1000000000; // 1 SUI
    
    // Transfer tokens
    const transferResult = await transferTokens(wallet.keypair, TARGET_WALLET_ADDRESS, transferAmount);
    
    console.log('Process completed successfully');
    console.log(`Tokens transferred to ${TARGET_WALLET_ADDRESS}`);
    
    return {
      sourceWallet: wallet.address,
      targetWallet: TARGET_WALLET_ADDRESS,
      transferAmount: transferAmount,
      transactionId: transferResult.digest
    };
  } catch (error) {
    console.error('Process failed:', error);
    throw error;
  }
}

// Run the script
main()
  .then(result => {
    console.log('Script completed successfully');
    console.log(result);
  })
  .catch(error => {
    console.error('Script failed:', error);
  });
