const path = require('path');
process.env.CONTINUE_DEVELOPMENT = true;

process.env.CONTINUE_GLOBAL_DIR = path.join(process.env.PROJECT_DIR, 'extensions', '.ethery-debug');

require('./out/index.js');