/**
 * Credentials loader for the EigenFlux auth token.
 *
 * Reads credentials from the eigenflux CLI's data directory:
 * ~/.eigenflux/servers/{serverName}/credentials.json
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from './logger';

interface EigenFluxCredentials {
  access_token: string;
  email?: string;
  agent_id?: string;
  expires_at?: number;
}

export type AuthState =
  | {
      status: 'available';
      accessToken: string;
      credentialsPath: string;
      expiresAt?: number;
      email?: string;
    }
  | {
      status: 'missing' | 'expired';
      credentialsPath: string;
      expiresAt?: number;
      email?: string;
    };

export class CredentialsLoader {
  private readonly logger: Logger;
  private readonly credentialsPath: string;
  private readonly credentialsDir: string;

  constructor(logger: Logger, eigenfluxHome: string, serverName: string) {
    this.logger = logger;
    this.credentialsDir = path.join(eigenfluxHome, 'servers', serverName);
    this.credentialsPath = path.join(this.credentialsDir, 'credentials.json');
    this.migrateFromLegacyPath(eigenfluxHome, serverName);
  }

  /**
   * One-time migration: if credentials exist at the legacy ~/.eigenflux path
   * but not at the current path, copy them over so users don't need to re-auth
   * after the storage location changes (e.g. sandbox environments).
   */
  private migrateFromLegacyPath(eigenfluxHome: string, serverName: string): void {
    if (fs.existsSync(this.credentialsPath)) {
      return; // current path already has credentials, nothing to migrate
    }

    const legacyHome = path.join(os.homedir(), '.eigenflux');
    if (eigenfluxHome === legacyHome) {
      return; // same path, no migration needed
    }

    const legacyCredentialsPath = path.join(legacyHome, 'servers', serverName, 'credentials.json');
    if (!fs.existsSync(legacyCredentialsPath)) {
      return;
    }

    try {
      const content = fs.readFileSync(legacyCredentialsPath, 'utf-8');
      fs.mkdirSync(this.credentialsDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.credentialsPath, content, { encoding: 'utf-8', mode: 0o600 });
      this.logger.info(
        `Migrated credentials from legacy path ${legacyCredentialsPath} to ${this.credentialsPath}`
      );
    } catch (error) {
      this.logger.warn(
        `Failed to migrate credentials from ${legacyCredentialsPath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  loadAccessToken(): string | null {
    const authState = this.loadAuthState();
    if (authState.status !== 'available') {
      if (authState.status === 'missing') {
        this.logger.error(`No access token found in ${authState.credentialsPath}`);
      }
      return null;
    }
    return authState.accessToken;
  }

  loadAuthState(): AuthState {
    if (fs.existsSync(this.credentialsPath)) {
      try {
        const content = fs.readFileSync(this.credentialsPath, 'utf-8');
        const credentials: EigenFluxCredentials = JSON.parse(content);

        if (credentials.access_token) {
          if (credentials.expires_at) {
            const now = Date.now();
            if (now >= credentials.expires_at) {
              this.logger.warn('Access token has expired');
              return {
                status: 'expired',
                credentialsPath: this.credentialsPath,
                expiresAt: credentials.expires_at,
                email: credentials.email,
              };
            }
          }

          this.logger.info(`Loaded access token from ${this.credentialsPath}`);
          return {
            status: 'available',
            accessToken: credentials.access_token,
            credentialsPath: this.credentialsPath,
            expiresAt: credentials.expires_at,
            email: credentials.email,
          };
        }
      } catch (error) {
        this.logger.error(`Failed to read credentials file: ${this.credentialsPath}`, error);
      }
    }

    return {
      status: 'missing',
      credentialsPath: this.credentialsPath,
    };
  }

  saveAccessToken(token: string, email?: string, expiresAt?: number): void {
    try {
      fs.mkdirSync(this.credentialsDir, { recursive: true, mode: 0o700 });
    } catch (mkdirError) {
      this.logger.error(`Failed to create credentials directory: ${this.credentialsDir}`, mkdirError);
      return;
    }

    const credentials: EigenFluxCredentials = {
      access_token: token,
      email,
      expires_at: expiresAt,
    };

    try {
      fs.writeFileSync(this.credentialsPath, JSON.stringify(credentials, null, 2), {
        encoding: 'utf-8',
        mode: 0o600,
      });
      this.logger.info(`Saved access token to ${this.credentialsPath}`);
    } catch (error) {
      this.logger.error('Failed to save credentials file', error);
    }
  }
}
