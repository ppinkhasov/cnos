// node-pty ships prebuilt binaries, but npm/prebuild extraction often drops the
// executable bit on its `spawn-helper` on macOS/Linux. Without +x, every PTY
// spawn dies with "posix_spawnp failed". Restore it after every install.
import { readdirSync, statSync, chmodSync } from 'fs';
import { join } from 'path';

const base = join(process.cwd(), 'node_modules', 'node-pty', 'prebuilds');
let fixed = 0;
try {
  for (const dir of readdirSync(base)) {
    const helper = join(base, dir, 'spawn-helper');
    try {
      const m = statSync(helper).mode;
      chmodSync(helper, m | 0o111); // add execute for user/group/other
      fixed++;
    } catch { /* no spawn-helper on this platform (e.g. win32) */ }
  }
  if (fixed) console.log(`[cnos] made ${fixed} node-pty spawn-helper(s) executable`);
} catch { /* node-pty not installed yet / no prebuilds dir */ }
