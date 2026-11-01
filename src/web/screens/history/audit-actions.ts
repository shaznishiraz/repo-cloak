import { api } from '../../shell/load.js';
import { toast } from '../../shell/ui/index.js';
import { downloadText, errorText } from '../repos/shared.js';

/** Saves the log, signature and public key as one file. Real source names are left out. */
export async function exportSignedLog() {
  try {
    const bundle = await api().call('POST /api/v2/audit/export');
    const day = new Date().toISOString().slice(0, 10);
    downloadText(`repo-cloak-audit-${day}.json`, `${JSON.stringify(bundle, null, 2)}\n`);
    toast(
      'Exported. The signature uses a one-time key, so send the auditor its public key separately.',
      'ok',
    );
  } catch (error) {
    toast(errorText(error), 'error');
  }
}
