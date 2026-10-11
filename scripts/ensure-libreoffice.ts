import { spawn } from 'node:child_process';
import { join } from 'node:path';

/**
 * Makes sure soffice is on this machine so Office files render to pages.
 * Replit and the Docker image already ship LibreOffice; local Windows needs this once.
 */
const WINDOWS_CANDIDATES = [
  process.env['LIBREOFFICE_BIN'],
  join(process.env['PROGRAMFILES'] ?? 'C:\\Program Files', 'LibreOffice', 'program', 'soffice.exe'),
  join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'LibreOffice', 'program', 'soffice.exe'),
  'soffice',
  'soffice.exe',
  'libreoffice',
].filter(Boolean) as string[];

function probe(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(bin, ['--version'], { stdio: 'ignore' });
    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0));
  });
}

async function find(): Promise<string | null> {
  for (const bin of WINDOWS_CANDIDATES) {
    if (await probe(bin)) return bin;
  }
  return null;
}

async function installWindows(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'winget',
      ['install', '--id', 'TheDocumentFoundation.LibreOffice', '-e', '--accept-package-agreements', '--accept-source-agreements'],
      { stdio: 'inherit' },
    );
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`winget exited ${code}`))));
  });
}

const found = await find();
if (found) {
  console.log(`LibreOffice ready: ${found}`);
  process.exit(0);
}

if (process.platform !== 'win32') {
  console.error('LibreOffice is not on PATH. Install the OS package (apt/nix) or set LIBREOFFICE_BIN.');
  process.exit(1);
}

console.log('LibreOffice is missing. Installing TheDocumentFoundation.LibreOffice via winget…');
await installWindows();
const after = await find();
if (!after) {
  console.error('Installed, but soffice.exe was not found. Restart the terminal and set LIBREOFFICE_BIN if needed.');
  process.exit(1);
}
console.log(`LibreOffice ready: ${after}`);
console.log('Restart the Next.js dev server so Golden picks it up.');
