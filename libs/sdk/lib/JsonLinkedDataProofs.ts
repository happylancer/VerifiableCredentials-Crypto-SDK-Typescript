/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Crypto, JoseBuilder, CryptoHelpers } from './index';
import { IPayloadProtectionSigning } from 'verifiablecredentials-crypto-sdk-typescript-protocols-common';
import { PublicKey } from 'verifiablecredentials-crypto-sdk-typescript-keys';
import base64url from 'base64url';
import { CryptoAlgorithm } from 'verifiablecredentials-crypto-sdk-typescript-keystore';
import { SubtleCryptoExtension } from 'verifiablecredentials-crypto-sdk-typescript-plugin';
const jsonld = require('jsonld');
const clone = require('clone');

export default class JsonLinkedDataProofs {

  /**
   * Create instance of <see @class Jose>
   * @param builder The builder object
   */
  constructor(
    private _signer: IPayloadProtectionSigning) {
  }

  private _credential: any | undefined;

  /**
   * Embed the signature into the payload
   * @param payload to embed signature
   */
  public async sign(payload: object): Promise<JsonLinkedDataProofs> {

    if (!payload) {
      throw new Error('JSON LD proofs input is undefined');
    }

    if (typeof payload !== 'object') {
      throw new Error('JSON LD proofs input should be an object');
    }
    const crypto = this._signer.builder.crypto;
    const [verifyData, proof] = await this.createVerifyData(payload, crypto);

    // sign payload


    let jwsSigner: IPayloadProtectionSigning = new JoseBuilder(this._signer.builder.crypto)
      .build();

    jwsSigner = await jwsSigner.sign(verifyData);
    const jws = jwsSigner.serialize();
    const splitter = jws.split('.');
    // Set payload
    const payloadToSign = Buffer.concat([Buffer.from(splitter[0]), Buffer.from('.'), verifyData]);
    
    const alg = 'eddsa';
    const algorithm: CryptoAlgorithm = CryptoHelpers.jwaToWebCrypto(alg);
    const subtleExtension = new SubtleCryptoExtension(crypto.builder.cryptoFactory);
    const signature = await subtleExtension.signByKeyStore(algorithm, crypto.builder.signingKeyReference, payloadToSign);

    proof.jws = `${splitter[0]}..${base64url.encode(Buffer.from(signature))}`;
    
    // Add proof, TODO support for multiple proofs
    (<any>payload).proof = proof;
    this._credential = payload;
    return this;
  }
  
  /**
   * Verify the signature.
   *
   * @param validationKeys Public key to validate the signature.
   * @returns True if signature validated.
   */
  public async verify(validationKeys?: PublicKey[]): Promise<boolean> {
    if (!this._credential) {
      return Promise.reject('Import a credential by deserialize');
    }

    // create payload
    const proof = this._credential.proof;
    const payload = clone(this._credential);
    delete payload.proof;

    const crypto = this._signer.builder.crypto;
    const [verifyData, _] = await this.createVerifyData(payload, crypto, proof);

    // Use derived payload as signature payload
    let signature = this._credential.proof.jws;
    const signParts = signature.split('.');
    if (signParts.length !== 3) {
      throw new Error('Signature is no valid JOSE token');
    }
    
    // Set payload
    const payloadToValidate = Buffer.concat([Buffer.from(signParts[0]), Buffer.from('.'), verifyData]);
    
    const alg = 'eddsa';
    const algorithm: CryptoAlgorithm = CryptoHelpers.jwaToWebCrypto(alg);
    const subtleExtension = new SubtleCryptoExtension(crypto.builder.cryptoFactory);
    const result = await subtleExtension.verifyByJwk(algorithm, validationKeys![0], base64url.toBuffer(signParts[2]), payloadToValidate);
    return result;
  }

  /**
  * Serialize a cryptographic token
  */
  public serialize(): string {
    if (!this._credential) {
      throw new Error('No credential to serialize');
    }

    return JSON.stringify(this._credential);
  }

  /**
   * Deserialize a credential
   * @param credential The credential to deserialize.
   */
  public deserialize(credential: string): JsonLinkedDataProofs {
    this._credential = JSON.parse(credential);
    return this;
  }

  /**
   * Create the reference data used for verification and signatures
   */
  public async createVerifyData(payload: any, crypto: Crypto, proof?: any, verificationMethod?: string, proofPurpose: string = 'assertionMethod'): Promise<[Buffer, any]> {
    verificationMethod = verificationMethod || `${crypto.builder.did}#${crypto.builder.signingKeyReference}`;

    let embeddedProof: any;
    if (!proof) {
      const type = 'Ed25519Signature2018';  // needs to be calculated and put in a seperate suite
      const created = new Date().toUTCString();
      embeddedProof = {
        '\@context': 'https://w3id.org/security/v2',
        type,
        verificationMethod,
        proofPurpose,
        created
      };  
    } else {
      embeddedProof = clone(proof);
      if (!embeddedProof['\@context']) {
        embeddedProof['\@context'] = 'https://w3id.org/security/v2';
      }
      delete embeddedProof.jws;
    }
    const proofCanonized = await jsonld.canonize(embeddedProof, {
      algorithm: 'URDNA2015',
      format: 'application/n-quads'
    });
    
    const payloadCanonized = await jsonld.canonize(payload, {
      algorithm: 'URDNA2015',
      format: 'application/n-quads'
    });
    console.log(`c14nProofOptions: '${proofCanonized}'`);
    console.log(`c14nDocument: '${payloadCanonized}'`);

    let proofHash = new Uint8Array(await crypto.builder.subtle.digest(
      {
        name: "SHA-256",
      },
      new Uint8Array(Buffer.from(proofCanonized))));
    let payloadHash = new Uint8Array(await crypto.builder.subtle.digest(
      {
        name: "SHA-256",
      },
      new Uint8Array(Buffer.from(payloadCanonized))));

    const result = Buffer.concat([proofHash, payloadHash]);
    delete embeddedProof['\@context'];
    console.log(`Hash: ${Buffer.from(result).toString('hex')}`);
    return [result, embeddedProof];
  }

}