import { issueSetupToken, resetAuthenticator, username } from '../src/modules/multi-user/accounts';
import { config, isMultiUser } from '../src/modules/multi-user/config';
import { closeDatabases, database } from '../src/modules/multi-user/database';
import fs from 'node:fs';
import path from 'node:path';

for (const file of ['.env.local', '.env']) if (fs.existsSync(file)) process.loadEnvFile(file);

async function main() {
    if (!isMultiUser()) throw new Error('Operator commands require multi-user mode.');
    const [command, argument] = process.argv.slice(2);
    if (command === 'setup-link') {
        console.log(issueSetupToken());
    } else if (command === 'recover') {
        const name = username(argument);
        const user = database().prepare("SELECT id FROM users WHERE username=? AND role='admin'").get(name) as
            { id: string } | undefined;
        if (!user) throw new Error('Administrator not found.');
        const provision = await resetAuthenticator(user.id, true);
        const file = path.join(config().dataDir, `recovery-${name}.png`);
        fs.writeFileSync(file, Buffer.from(provision.qr.split(',')[1], 'base64'), { mode: 0o600 });
        console.log(
            `Authenticator replaced; sessions revoked. QR: ${file}\nManual key: ${provision.secret}\nRemove the QR file after scanning it.`
        );
    } else throw new Error('Usage: npm run admin -- setup-link | recover <admin-username>');
}
main()
    .catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    })
    .finally(closeDatabases);
