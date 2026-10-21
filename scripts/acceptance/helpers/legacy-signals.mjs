/** Adapt historical artifacts' SIGTERM handlers to Windows IPC without rewriting them. */
process.on('message', (message) => {
  if (message?.type !== 'violet-map:shutdown') return;
  process.emit('SIGTERM');
  if (process.connected) process.disconnect();
});
process.channel?.unref();
