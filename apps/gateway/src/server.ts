import {buildApp} from './app.js';import {loadConfig} from './config.js';
const c=loadConfig();const {app}=await buildApp();const stop=async()=>{await app.close();process.exit(0)};process.on('SIGTERM',stop);process.on('SIGINT',stop);await app.listen({host:c.HOST,port:c.PORT});
