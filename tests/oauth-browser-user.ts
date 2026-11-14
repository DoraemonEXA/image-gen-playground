import { createUser } from '../src/modules/multi-user/accounts';
import { closeDatabases } from '../src/modules/multi-user/database';

createUser('oauth-browser')
    .then(({ username, secret }) => {
        process.stdout.write(JSON.stringify({ username, secret }));
    })
    .finally(closeDatabases);
