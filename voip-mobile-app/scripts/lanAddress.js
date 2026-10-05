const dgram = require('node:dgram');
const { isIPv4 } = require('node:net');

function detectLanAddress() {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const onError = (error) => {
      socket.close();
      reject(error);
    };

    socket.once('error', onError);
    socket.connect(9, '1.1.1.1', () => {
      socket.removeListener('error', onError);
      const address = socket.address().address;
      socket.close();
      resolve(address);
    });
  });
}

async function getLanAddress() {
  const address = process.env.RINGIO_LAN_IP || await detectLanAddress();
  if (!isIPv4(address) || address.startsWith('127.') || address.startsWith('169.254.')) {
    throw new Error(`Invalid LAN IPv4 address: ${address}`);
  }
  return address;
}

module.exports = { getLanAddress };