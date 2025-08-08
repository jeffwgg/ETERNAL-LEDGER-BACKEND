// @ts-nocheck
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fileUpload from 'express-fileupload';
import { tmpdir } from 'os';
import { join } from 'path';
import { promises as fs } from 'fs';
import { filesFromPaths } from 'files-from-path';
import { create } from '@storacha/client';
import { StoreMemory } from '@storacha/client/stores/memory';
import { Signer } from '@storacha/client/principal/ed25519';
import * as Proof from '@storacha/client/proof';
import { ethers } from 'ethers';

const app = express();
app.use(cors());
app.use(fileUpload({
  limits: { fileSize: 10 * 1024 * 1024 },
  abortOnLimit: true,
}));
app.use(express.json());

/** Initialize Storacha client with proof delegation */
async function initializeStorachaClient() {
  const key = process.env.IPFS_STORAGE_KEY?.trim();
  const proofBase64 = process.env.IPFS_STORAGE_PROOF?.trim();
  const spaceDID = process.env.IPFS_STORAGE_SPACE?.trim();

  if (!key || !proofBase64 || !spaceDID) {
    throw new Error('Missing one of: IPFS_STORAGE_KEY, IPFS_STORAGE_PROOF, IPFS_STORAGE_SPACE');
  }

  const principal = Signer.parse(key);
  const store = new StoreMemory();
  const client = await create({ principal, store });

  const proof = await Proof.parse(proofBase64);
  const space = await client.addSpace(proof);
  await client.setCurrentSpace(space.did());

  return client;
}

/** Initialize Ethereum provider and contract */
async function initializeContract() {
  const providerUrl = process.env.ETHEREUM_PROVIDER_URL?.trim();
  const privateKey = process.env.WALLET_PRIVATE_KEY?.trim();
  const contractAddress = process.env.CONTRACT_ADDRESS?.trim();

  if (!providerUrl || !privateKey || !contractAddress) {
    throw new Error('Missing one of: ETHEREUM_PROVIDER_URL, WALLET_PRIVATE_KEY, CONTRACT_ADDRESS');
  }

  const provider = new ethers.JsonRpcProvider(providerUrl);
  const wallet = new ethers.Wallet(privateKey, provider);

  // FULL ABI including isDeceased and getTokenByNric, records, etc.
  const contractABI = [
    {
      "inputs": [
        { "internalType": "string", "name": "nric", "type": "string" },
        { "internalType": "address", "name": "wallet", "type": "address" }
      ],
      "name": "bindIdentity",
      "outputs": [],
      "stateMutability": "nonpayable",
      "type": "function"
    },
    {
      "inputs": [
        { "internalType": "string", "name": "nric", "type": "string" },
        { "internalType": "string", "name": "metadataCID", "type": "string" }
      ],
      "name": "recordDeath",
      "outputs": [],
      "stateMutability": "nonpayable",
      "type": "function"
    },
    {
      "inputs": [
        { "internalType": "string", "name": "", "type": "string" }
      ],
      "name": "nricToWallet",
      "outputs": [
        { "internalType": "address", "name": "", "type": "address" }
      ],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [
        { "internalType": "address", "name": "", "type": "address" }
      ],
      "name": "walletToNric",
      "outputs": [
        { "internalType": "string", "name": "", "type": "string" }
      ],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [
        { "internalType": "address", "name": "registrar", "type": "address" }
      ],
      "name": "authorizeRegistrar",
      "outputs": [],
      "stateMutability": "nonpayable",
      "type": "function"
    },
    {
      "inputs": [
        { "internalType": "address", "name": "", "type": "address" }
      ],
      "name": "authorizedRegistrars",
      "outputs": [
        { "internalType": "bool", "name": "", "type": "bool" }
      ],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [
        { "internalType": "string", "name": "nric", "type": "string" }
      ],
      "name": "isDeceased",
      "outputs": [
        { "internalType": "bool", "name": "", "type": "bool" }
      ],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [
        { "internalType": "string", "name": "nric", "type": "string" }
      ],
      "name": "getTokenByNric",
      "outputs": [
        { "internalType": "uint256", "name": "", "type": "uint256" }
      ],
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [
        { "internalType": "uint256", "name": "", "type": "uint256" }
      ],
      "name": "records",
      "outputs": [
        { "internalType": "string", "name": "metadataCID", "type": "string" },
        { "internalType": "uint256", "name": "timestamp", "type": "uint256" }
      ],
      "stateMutability": "view",
      "type": "function"
    }
  ];

  const contract = new ethers.Contract(contractAddress, contractABI, wallet);
  return { contract, wallet };
}

/** Upload file to IPFS */
async function uploadFileToIPFS(file) {
  const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png', 'application/json'];
  if (!allowedTypes.includes(file.mimetype)) {
    throw new Error('Invalid file type. Only PDF, JPEG, PNG, or JSON allowed.');
  }

  const tempFilePath = join(tmpdir(), `upload-${Date.now()}-${file.name}`);
  await file.mv(tempFilePath);

  const client = await initializeStorachaClient();
  const files = await filesFromPaths([tempFilePath]);
  if (!files.length) throw new Error('Failed to load file from temp path');

  const cid = await client.uploadFile(files[0]);
  await fs.unlink(tempFilePath);

  return cid.toString();
}

/** Upload endpoint */
app.post('/upload', async (req, res) => {
  try {
    const uploadedFile = req.files?.file;
    if (!uploadedFile) return res.status(400).json({ error: 'No file uploaded' });

    const cid = await uploadFileToIPFS(uploadedFile);
    res.json({ cid });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/** Bind identity endpoint */
app.post('/bind-identity', async (req, res) => {
  try {
    const { nric, wallet } = req.body;
    if (!nric || !wallet) return res.status(400).json({ error: 'NRIC and wallet address are required' });
    if (!ethers.isAddress(wallet)) return res.status(400).json({ error: 'Invalid wallet address' });
    if (wallet === ethers.ZeroAddress) return res.status(400).json({ error: 'Wallet cannot be zero address' });

    const { contract, wallet: signerWallet } = await initializeContract();
    const existingWallet = await contract.nricToWallet(nric);
    const existingNric = await contract.walletToNric(wallet);
    if (existingWallet !== ethers.ZeroAddress) return res.status(400).json({ error: 'NRIC already bound', existingWallet });
    if (existingNric !== '') return res.status(400).json({ error: 'Wallet already bound', existingNric });

    const registrarAddress = await signerWallet.getAddress();
    const isAuthorized = await contract.authorizedRegistrars(registrarAddress);
    if (!isAuthorized) return res.status(403).json({ error: 'Not authorized registrar' });

    const tx = await contract.bindIdentity(nric, wallet);
    const receipt = await tx.wait();
    res.json({ message: 'Identity bound successfully', transactionHash: tx.hash, blockNumber: receipt.blockNumber });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/** Record death endpoint */
app.post('/record-death', async (req, res) => {
  try {
    const { nric, metadataCID } = req.body;
    let finalCID = metadataCID;

    if (!nric) return res.status(400).json({ error: 'NRIC is required' });
    if (!finalCID) {
      const uploadedFile = req.files?.file;
      if (!uploadedFile) return res.status(400).json({ error: 'Either metadataCID or file is required' });
      finalCID = await uploadFileToIPFS(uploadedFile);
    }

    const { contract, wallet: signerWallet } = await initializeContract();
    const registrarAddress = await signerWallet.getAddress();
    const isAuthorized = await contract.authorizedRegistrars(registrarAddress);
    if (!isAuthorized) return res.status(403).json({ error: 'Not authorized registrar' });

    const boundWallet = await contract.nricToWallet(nric);
    if (boundWallet === ethers.ZeroAddress) return res.status(404).json({ error: 'NRIC not registered' });

    const tx = await contract.recordDeath(nric, finalCID);
    const receipt = await tx.wait();
    res.json({ message: 'Death recorded and SBT minted', metadataCID: finalCID, transactionHash: tx.hash, blockNumber: receipt.blockNumber });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/** Search by NRIC endpoint */
app.get('/search-by-nric/:nric', async (req, res) => {
  try {
    const { nric } = req.params;
    const { contract } = await initializeContract();

    const wallet = await contract.nricToWallet(nric);
    if (wallet === ethers.ZeroAddress) return res.status(404).json({ error: 'NRIC not registered' });

    const isDeceased = await contract.isDeceased(nric);
    let tokenId = null;
    let record = null;

    if (isDeceased) {
      tokenId = await contract.getTokenByNric(nric);
      record = await contract.records(tokenId);
      record = {
        metadataCID: record.metadataCID,
        timestamp: record.timestamp.toString()
      };
    }

    res.json({
      nric,
      wallet,
      isDeceased,
      tokenId: tokenId ? tokenId.toString() : null,
      record,
      tokenURI: isDeceased ? `ipfs://${record.metadataCID}` : null
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to search NRIC', details: error.message });
  }

});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
