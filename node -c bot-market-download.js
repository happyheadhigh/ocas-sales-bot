warning: in the working copy of 'bot-market-download.js', LF will be replaced by CRLF the next time Git touches it
[1mdiff --git a/bot-market-download.js b/bot-market-download.js[m
[1mindex 363eba3..da68cb3 100644[m
[1m--- a/bot-market-download.js[m
[1m+++ b/bot-market-download.js[m
[36m@@ -468,42 +468,77 @@[m [masync function startMarketPoller(client){[m
   setTimeout(tick, 5000);[m
 }[m
 [m
[32m+[m[32mfunction wrapReadyListener(listener){[m
[32m+[m[32m  return async function(...args){[m
[32m+[m[32m    try{[m
[32m+[m[32m      await listener.apply(this, args);[m
[32m+[m[32m    }catch(e){[m
[32m+[m[32m      console.error('[Wrapped ready original]', e.message);[m
[32m+[m[32m    }[m
[32m+[m[32m    startMarketPoller(this).catch(e=>console.error('[Market start]', e.message));[m
[32m+[m[32m  };[m
[32m+[m[32m}[m
[32m+[m
[32m+[m[32mfunction wrapInteractionListener(listener){[m
[32m+[m[32m  return async function(interaction, ...args){[m
[32m+[m[32m    try{[m
[32m+[m[32m      if(interaction.isChatInputCommand?.() && interaction.commandName === 'market'){[m
[32m+[m[32m        await handleMarketCommand(interaction);[m
[32m+[m[32m        return;[m
[32m+[m[32m      }[m
[32m+[m[32m      if(interaction.isChatInputCommand?.() && interaction.commandName === 'download'){[m
[32m+[m[32m        await handleDownloadCommand(interaction);[m
[32m+[m[32m        return;[m
[32m+[m[32m      }[m
[32m+[m[32m      if(interaction.isButton?.() && interaction.customId?.startsWith('ocas_download:')){[m
[32m+[m[32m        const [, token, size, transparentFlag] = interaction.customId.split(':');[m
[32m+[m[32m        await handleDownloadCommand(interaction, {[m
[32m+[m[32m          tokenId:parseInt(token,10),[m
[32m+[m[32m          size:parseInt(size||'2048',10),[m
[32m+[m[32m          transparent:transparentFlag === '1',[m
[32m+[m[32m          ephemeral:true[m
[32m+[m[32m        });[m
[32m+[m[32m        return;[m
[32m+[m[32m      }[m
[32m+[m[32m      if(interaction.isChatInputCommand?.() && interaction.commandName === 'ocas'){[m
[32m+[m[32m        patchOcasInteraction(interaction);[m
[32m+[m[32m      }[m
[32m+[m[32m    }catch(e){[m
[32m+[m[32m      console.error('[Market/download wrapper]', e.message);[m
[32m+[m[32m      try{[m
[32m+[m[32m        if(!interaction.replied && !interaction.deferred){[m
[32m+[m[32m          await interaction.reply({content:'Error: '+e.message, flags:MessageFlags.Ephemeral});[m
[32m+[m[32m        }[m
[32m+[m[32m      }catch(_){}[m
[32m+[m[32m      return;[m
[32m+[m[32m    }[m
[32m+[m[32m    return listener.call(this, interaction, ...args);[m
[32m+[m[32m  };[m
[32m+[m[32m}[m
[32m+[m
 const originalOn = Client.prototype.on;[m
[32m+[m[32mconst originalOnce = Client.prototype.once;[m
[32m+[m
[32m+[m[32m// Existing bot boots with client.once('clientReady'), not client.on('ready').[m
[32m+[m[32m// Patch both on() and once(), and support both event names, so the market poller actually starts.[m
 Client.prototype.on = function(event, listener){[m
[31m-  if(event === 'ready'){[m
[31m-    return originalOn.call(this, event, async (...args) => {[m
[31m-      try{ await listener.apply(this, args); }catch(e){ console.error('[Wrapped ready original]', e.message); }[m
[31m-      startMarketPoller(this).catch(e=>console.error('[Market start]', e.message));[m
[31m-    });[m
[32m+[m[32m  if(event === 'ready' || event === 'clientReady'){[m
[32m+[m[32m    return originalOn.call(this, event, wrapReadyListener(listener));[m
   }[m
   if(event === 'interactionCreate'){[m
[31m-    return originalOn.call(this, event, async (interaction, ...args) => {[m
[31m-      try{[m
[31m-        if(interaction.isChatInputCommand?.() && interaction.commandName === 'market'){[m
[31m-          await handleMarketCommand(interaction);[m
[31m-          return;[m
[31m-        }[m
[31m-        if(interaction.isChatInputCommand?.() && interaction.commandName === 'download'){[m
[31m-          await handleDownloadCommand(interaction);[m
[31m-          return;[m
[31m-        }[m
[31m-        if(interaction.isButton?.() && interaction.customId?.startsWith('ocas_download:')){[m
[31m-          const [, token, size, transparentFlag] = interaction.customId.split(':');[m
[31m-          await handleDownloadCommand(interaction, { tokenId:parseInt(token,10), size:parseInt(size||'2048',10), transparent:transparentFlag === '1', ephemeral:true });[m
[31m-          return;[m
[31m-        }[m
[31m-        if(interaction.isChatInputCommand?.() && interaction.commandName === 'ocas'){[m
[31m-          patchOcasInteraction(interaction);[m
[31m-        }[m
[31m-      }catch(e){[m
[31m-        console.error('[Market/download wrapper]', e.message);[m
[31m-        try{ if(!interaction.replied && !interaction.deferred) await interaction.reply({content:'Error: '+e.message, flags:MessageFlags.Ephemeral}); }catch(_){}[m
[31m-        return;[m
[31m-      }[m
[31m-      return listener.call(this, interaction, ...args);[m
[31m-    });[m
[32m+[m[32m    return originalOn.call(this, event, wrapInteractionListener(listener));[m
   }[m
   return originalOn.call(this, event, listener);[m
 };[m
 [m
[32m+[m[32mClient.prototype.once = function(event, listener){[m
[32m+[m[32m  if(event === 'ready' || event === 'clientReady'){[m
[32m+[m[32m    return originalOnce.call(this, event, wrapReadyListener(listener));[m
[32m+[m[32m  }[m
[32m+[m[32m  if(event === 'interactionCreate'){[m
[32m+[m[32m    return originalOnce.call(this, event, wrapInteractionListener(listener));[m
[32m+[m[32m  }[m
[32m+[m[32m  return originalOnce.call(this, event, listener);[m
[32m+[m[32m};[m
[32m+[m
 require('./bot.js');[m
