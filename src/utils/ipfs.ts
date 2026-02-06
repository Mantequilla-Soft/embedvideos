import { createReadStream } from 'fs';
import { loadConfig } from '../config/config';
import FormData from 'form-data';
import http from 'http';
import https from 'https';

const config = loadConfig();

/**
 * Pin a file to IPFS using local daemon first, fallback to supernode
 * @param filePath Absolute path to the file to pin
 * @returns Object with CID and endpoint where it was pinned
 */
export async function pinFile(filePath: string): Promise<{ cid: string; endpoint: string }> {
  const localEndpoint = 'http://127.0.0.1:5001';
  
  // Try local daemon first
  try {
    console.log(`Attempting to pin to local IPFS daemon: ${localEndpoint}`);
    const cid = await addToIpfs(localEndpoint, filePath);
    console.log(`Successfully pinned to local daemon: ${cid}`);
    return { cid, endpoint: localEndpoint };
  } catch (localError) {
    console.warn(`Local IPFS daemon failed: ${localError}`);
    console.log(`Falling back to supernode: ${config.ipfsSupernodeEndpoint}`);
    
    // Fallback to supernode
    try {
      const cid = await addToIpfs(config.ipfsSupernodeEndpoint, filePath);
      console.log(`Successfully pinned to supernode: ${cid}`);
      return { cid, endpoint: config.ipfsSupernodeEndpoint };
    } catch (supernodeError) {
      console.error(`Supernode IPFS failed: ${supernodeError}`);
      throw new Error(`Failed to pin file to IPFS: ${supernodeError}`);
    }
  }
}

/**
 * Announce CID to DHT for better discoverability
 * @param cid IPFS CID to announce
 */
export async function announceDHT(cid: string): Promise<void> {
  // Try local daemon first
  try {
    console.log(`Announcing to DHT via local daemon: ${cid}`);
    await provideDHT('http://127.0.0.1:5001', cid);
    console.log(`Successfully announced to DHT via local daemon: ${cid}`);
  } catch (localError) {
    console.warn(`Local IPFS daemon DHT announce failed: ${localError}`);
  }
  
  // Try supernode
  try {
    console.log(`Announcing to DHT via supernode: ${cid}`);
    await provideDHT(config.ipfsSupernodeEndpoint, cid);
    console.log(`Successfully announced to DHT via supernode: ${cid}`);
  } catch (supernodeError) {
    console.warn(`Supernode IPFS DHT announce failed: ${supernodeError}`);
  }
}

/**
 * Unpin a CID from IPFS at specific endpoint
 * @param cid IPFS CID to unpin
 * @param endpoint IPFS endpoint where the file was pinned
 */
export async function unpinFile(cid: string, endpoint: string): Promise<void> {
  try {
    console.log(`Attempting to unpin from ${endpoint}: ${cid}`);
    await unpinFromIpfs(endpoint, cid);
    console.log(`Successfully unpinned from ${endpoint}: ${cid}`);
  } catch (error) {
    console.warn(`IPFS unpin failed at ${endpoint}: ${error}`);
    throw error;
  }
}

async function addToIpfs(apiUrl: string, filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append('file', createReadStream(filePath));
    
    const url = new URL(`${apiUrl}/api/v0/add?pin=true`);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;
    
    const req = client.request({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: formData.getHeaders(),
    }, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        if (res.statusCode !== 200) {
          console.error(`IPFS API error response: ${data}`);
          reject(new Error(`IPFS API error: ${res.statusCode} ${res.statusMessage}`));
          return;
        }
        
        try {
          const result = JSON.parse(data) as { Hash: string };
          resolve(result.Hash);
        } catch (error) {
          reject(new Error(`Failed to parse IPFS response: ${error}`));
        }
      });
    });
    
    req.on('error', (error) => {
      reject(error);
    });
    
    formData.pipe(req);
  });
}

async function unpinFromIpfs(apiUrl: string, cid: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${apiUrl}/api/v0/pin/rm?arg=${cid}`);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;
    
    const req = client.request({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
    }, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        if (res.statusCode !== 200) {
          console.error(`IPFS unpin API error response: ${data}`);
          reject(new Error(`IPFS unpin API error: ${res.statusCode} ${res.statusMessage}`));
          return;
        }
        resolve();
      });
    });
    
    req.on('error', (error) => {
      reject(error);
    });
    
    req.end();
  });
}

async function provideDHT(apiUrl: string, cid: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${apiUrl}/api/v0/dht/provide?arg=${cid}`);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;
    
    const req = client.request({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
    }, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        if (res.statusCode !== 200) {
          console.error(`IPFS DHT provide API error response: ${data}`);
          reject(new Error(`IPFS DHT provide API error: ${res.statusCode} ${res.statusMessage}`));
          return;
        }
        resolve();
      });
    });
    
    req.on('error', (error) => {
      reject(error);
    });
    
    req.end();
  });
}
