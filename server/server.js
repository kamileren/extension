// server.js - LAN relay server for Race Light extension
// Run: node server.js
// Requires: npm install ws

const { WebSocketServer } = require('ws');
const os = require('os');

const PORT = 8765;
const wss = new WebSocketServer({ port: PORT });

let lastState = null;
const clients = new Set();

function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

wss.on('listening', () => {
  const ips = getLocalIPs();
  console.log('\n=== Race Light Relay Server ===');
  console.log(`Port: ${PORT}`);
  console.log('\nYour local IP address(es):');
  ips.forEach(ip => console.log(`  ${ip}`));
  console.log('\nEnter one of these IPs into the extension popup.');
  console.log('Windows firewall may prompt you to allow Node.js — click Allow.');
  console.log('\nWaiting for connections...\n');
});

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`Client connected (${clients.size} total)`);

  // Send last known state to newly connected client
  if (lastState) {
    ws.send(JSON.stringify(lastState));
  }

  ws.on('message', (data) => {
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch (e) {
      return;
    }

    // Ignore pings
    if (parsed.ping) return;

    // Save state
    lastState = parsed;

    // Broadcast to all OTHER clients
    for (const client of clients) {
      if (client !== ws && client.readyState === 1) {
        client.send(JSON.stringify(parsed));
      }
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`Client disconnected (${clients.size} total)`);
  });

  ws.on('error', () => {
    clients.delete(ws);
  });
});

wss.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Kill the other process or change the port.`);
  } else {
    console.error('Server error:', err.message);
  }
  process.exit(1);
});
