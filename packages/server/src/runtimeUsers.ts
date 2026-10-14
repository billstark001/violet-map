import { config } from './config.js';
import { getDatabase } from './db/index.js';
import { createUserService } from './users.js';

export const userService = createUserService(getDatabase, config);
