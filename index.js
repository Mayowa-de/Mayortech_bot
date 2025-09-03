const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode');
const P = require('pino')
const qrcodeTerminal= require('qrcode-terminal');
const fs = require('fs-extra')
require('dotenv').config

//configuration 
const ADMIN_NUMBER =process.env.ADMIN_NUMBER || '+2349017347171@s.whatsapp.net';
const BIBLE_API ='https://bible-api.com/';
const logger =P({
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    transport: {
        target: 'pino/file',
        options: {destination: 'log/combined.log', mkdir: true},

    },
})

//store view-once messages
const viewOnceStore = new Map(); // {jid: {text string, media:buffer, mimetype: string}}

//fetch  Bible verse
async function fetchBibleVerse(reference) {
    const {fetch: nodeFetch } = await import('node-fetch');
    try{
        const response= await nodeFetch(`${BIBLE_API}${encodeURIComponent(reference)}?tanslation=kjv`);
        if(!response.ok) throw new Error(`API error: ${data.translation}`)
    }catch (error){
        logger.error('Bible API error:', error);
        return 'Error fetching verse. Try again or use format: /bible John 3:16';
    }
}

//check if message is a command
function isCommand(text, command){
    return text.trim().toLowerCase().startsWith(`${command}`);
}

//Extract Bible message
function extractReference(text){
    const part =text.trim().split(' ').slice(1).join(' ')
    return part || 'john+3:16';
}

//save view-once message
async function saveViewOnceMessage(msg) {
    const jid =msg.key.remoteJid;
    let content = {}
    if(msg.message.viewOnceMessageV2){
        const v =msg.message.viewOnceMessageV2.message;
        if(v.conversation){
            content.text= v.conversation;
        } else if(v.imageMessage || v.videoMessage){
            const  mediaKey= v.imageMessage ? 'imageMessage' : 'videoMessage';
            content.media= await downloadMediaMessage(msg, 'buffer', {}, {logger});
            content.mimetype = v[mediaKey].mimetype;
        }
    }
    viewOnceStore.set(jid, content);
    logger.info(`Saved view-once for ${jid}`)
}

//Main bot function
async function startBot() {
    const {default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage}= await import('@whiskeysockets/baileys');
    const {state, saveCreds} = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger,
        printQRInTerminal: false,
        generateHighQualityLinkPreview: true,
    });

    //Save credentials
    sock.ev.on('creds.update', saveCreds);

    //Handle connection updates
    sock.ev.on('connection.update', async(update)=>{
        const {connection, lastDisconnect, qr}= update;
        if(qr){
            //Terminal QR
            qrcodeTerminal.generate(qr, { small: true});
            console.log('Scan the QR above or enter phone number for pairing.');

            //Send QR as image to admin
            try{
                const qrImage = await qrcode.toBuffer(qr, {scale: 2});
                await sock.sendMessage(ADMIN_NUMBER, {
                    image: qrImage,
                    caption: 'Scan this QR to authenticate the bot.',
                })
                console.log(`QR sent to ${ADMIN_NUMBER}`);
            }catch (error){
                logger.error('Failed to send QR image:', error);
            }

            //Phone number pairing
            const readline= require('readline').createInterface({
                input: process.stdin,
                output: process.stdout,
            })
            readline.question('Enter phone number (e.g., +12345678901) or skip (press Enter):', async(phone)=>{
                readline.close();
                if(phone){
                    try{
                        const pairingCode= await sock.requestPairingCode(phone.replace(/[^0-9]/g, ''));
                        console.log(`Pairing code: ${pairingCode}`);
                        await sock.sendMessage(ADMIN_NUMBER, {text: `Pairing code: ${pairingCode}`})
                    }catch(error){
                        logger.error('Pairing error:', error);
                        console.log('Pairing failed. Please scan QR instead.')
                    }
                }
            })
        }
        if(connection === 'close'){
            const error =lastDisconnect?.error;
            const statusCode = error && error.output && error.output.statusCode ? error.output.statusCode: null;
            if(statusCode !== DisconnectReason.loggedOut){
                logger.info('Reconnecting...');
                startBot();
            } else{
                logger.error('Logged out. Delete auth_info_baileys and restart.');
                console.log('Logged out.  Delete auth_info_baileys folder and restart.');
            } 
            } else if (connection === 'open'){
                console.log('WhatsApp Bot connected! Commands: /bible. /everyone, /view ');
                await sock.sendMessage(ADMIN_NUMBER, {text: 'Bot online! Ready to process /bible, /everyone, /view commands.'})
            }
    })

    //Handle incoming message
    sock.ev.on('messages.upsert', async({message, type})=>{
        if(type !== 'notify') return;
        if(!message || !message.messages || message.messages.length > 0) return
         const msg =message[0]
         if(!msg.message) return
         if(msg.key.fromMe) return; //Ignore own messages

        const jid= msg.key.remoteJid;
        const text =msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const isGroup= jid.endsWith('@g.us');
        logger.info(`Message from ${jid}: ${text}`);
        
        //Handle view-once messages
        if(msg.message.viewOnceMessageV2){
            await saveViewOnceMessage(msg);
        }

        //Process commands
        if(isCommand(text, 'bible')){
            const reference = extractReference(text);
            const verse = await fetchBibleVerse(reference);
            await sock.sendMessage(jid, {text: verse});
            logger.info(`Sent verse for ${reference} to ${jid}`);
        }else if(isCommand(text, 'everyone') && isGroup){
            try{
                const groupMetadata = await sock.groupMetadata(jid);
                const participants = groupMetadata.participants.map(p=> ({
                    id: p.id,
                    tag: p.id.split('@')[0]
                }))
                const mentions= participants.map(p=> p.id);
                const mentionText = participants.map(p=> `@${p.tag}`).join(' ')
                await sock.sendMessage(jid, {text: `Mentioning everyone: ${mentionText}`, mentions});
                logger.info(`Mention everyone in ${jid}`);
            }catch (error){
                logger.error('Error mentioning everyone:', error);
                await sock.sendMessage(jid, {text: 'Failed to Mention everyone. Try again.'})
            }
        }else if(isCommand(text, 'view')){
            const stored = viewOnceStore.get(jid);
            if(!stored){
                await sock.sendMessage(jid, {text: 'No view-once message stored for this chat.'});
                return;
            }
            if(stored.text){
                await sock.sendMessage(jid, {text: `Stored view-once text: ${stored.text}`});
            }else if(stored.media && stored.mimetype){
                await sock.sendMessage(jid, {
                    [stored.mimetype.startsWith('image') ? 'image': 'video']: stored.media,
                    caption: 'Stored view-once media',
                });
            }
            logger.info(`Sent stored view-once to ${jid}`);
        }
    })

    //Handle group participant updates
    sock.ev.on('group-participants.update', async({id, participants, action})=>{
        logger.info('Shutting down bot...');
        await sock.end();
        process.exit(0)
    })
}

//Ensure logs directory exists 
fs.ensureDirSync('logs');

//start Bot
startBot().catch((error)=>{
    logger.error('Bot startup:', error);
    console.error('Failed to start bot:', error)
})