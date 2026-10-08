// A service account key built at runtime, so no key-shaped literal ever sits in the repository.
// The shape is the JSON key file Google issues (type, project_id, private_key_id, private_key,
// client_email, token_uri).
import { generateKeyPairSync } from 'node:crypto';

let cached = null;
export function serviceAccountKey() {
  if (!cached) {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    cached = {
      json: {
        type: 'service_account',
        project_id: 'demo-project',
        private_key_id: '5f1e2d3c4b5a69788796a5b4c3d2e1f001234567',
        private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
        client_email: 'revenue-sync@demo-project.iam.gserviceaccount.com',
        client_id: '100000000000000000001',
        token_uri: 'https://oauth2.googleapis.com/token',
      },
      publicKey,
    };
  }
  return cached;
}
