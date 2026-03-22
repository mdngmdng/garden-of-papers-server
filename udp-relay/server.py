import socket
import logging
import time

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
)

# "0.0.0.0" means accept connections from any network.
SERVER_IP = "0.0.0.0"
SERVER_PORT = 8925
BUFFER_SIZE = 8192

# When False, the sender won't receive their own message back.
LOOP_BACK = False

# Clients silent for this many seconds are considered disconnected.
CLIENT_TIMEOUT = 2

# Create a UDP socket for sending and receiving data.
server_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

# Tell the OS to route data going to this port to our server_socket.
server_socket.bind((SERVER_IP, SERVER_PORT))

this_ip = socket.gethostbyname(socket.gethostname())
logging.info(f"UDP server listening on {this_ip}:{SERVER_PORT}")

# Tracks connected clients as {(ip, port): last_seen_time}.
clients = {}

while True:
    try:
        # Wait for a client to send data, then return the data and sender's address.
        data, sender = server_socket.recvfrom(BUFFER_SIZE)

        # Register new clients at their first message.
        if sender not in clients:
            logging.info(f"New client connected: {sender}")
        clients[sender] = time.time()

        # Broadcast to all other active clients.
        now = time.time()
        for client in list(clients):
            if client == sender and not LOOP_BACK:
                continue
            # Remove clients that have gone silent.
            if now - clients[client] > CLIENT_TIMEOUT:
                logging.info(f"Removing inactive client: {client}")
                del clients[client]
            else:
                server_socket.sendto(data, client)

    except OSError as e:
        # Error 10054 (Windows) / ECONNRESET (Linux): client closed its socket
        err_code = getattr(e, 'winerror', None) or e.errno
        if err_code in (10054, 104):  # 10054=Windows, 104=ECONNRESET Linux
            logging.info(f"Client disconnected: {sender}")
            clients.pop(sender, None)
        else:
            logging.error(f"Socket error: {e}")
