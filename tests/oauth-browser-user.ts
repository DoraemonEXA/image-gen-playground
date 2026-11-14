import { createUser } from '../src/modules/multi-user/accounts';
import { adjustBalance, balance } from '../src/modules/multi-user/billing';
import { closeDatabases, database } from '../src/modules/multi-user/database';

createUser('oauth-browser')
    .then(({ username, secret }) => {
        const { id } = database().prepare('SELECT id FROM users WHERE username=?').get(username) as { id: string };
        adjustBalance(id, 'add', '1', 'MCP browser test funds', balance().version);
        process.stdout.write(JSON.stringify({ username, secret }));
    })
    .finally(closeDatabases);
