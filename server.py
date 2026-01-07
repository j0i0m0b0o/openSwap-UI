#!/usr/bin/env python3
"""
openSwap UI - Development Server
Simple HTTP server with CORS support for local development
"""

import http.server
import socketserver
import os
import sys

PORT = 8080
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

class CORSHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def log_message(self, format, *args):
        print(f"\033[90m{self.address_string()}\033[0m - {args[0]}")

def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else PORT

    with socketserver.TCPServer(("", port), CORSHTTPRequestHandler) as httpd:
        print(f"""
\033[38;2;0;217;255m╔═══════════════════════════════════════════════════════════╗
║                                                             ║
║   ██████╗ ██████╗ ███████╗███╗   ██╗███████╗██╗    ██╗ █████╗ ██████╗  ║
║  ██╔═══██╗██╔══██╗██╔════╝████╗  ██║██╔════╝██║    ██║██╔══██╗██╔══██╗ ║
║  ██║   ██║██████╔╝█████╗  ██╔██╗ ██║███████╗██║ █╗ ██║███████║██████╔╝ ║
║  ██║   ██║██╔═══╝ ██╔══╝  ██║╚██╗██║╚════██║██║███╗██║██╔══██║██╔═══╝  ║
║  ╚██████╔╝██║     ███████╗██║ ╚████║███████║╚███╔███╔╝██║  ██║██║      ║
║   ╚═════╝ ╚═╝     ╚══════╝╚═╝  ╚═══╝╚══════╝ ╚══╝╚══╝ ╚═╝  ╚═╝╚═╝      ║
║                                                             ║
╚═══════════════════════════════════════════════════════════╝\033[0m

\033[38;2;0;217;255m→\033[0m Server running at \033[1mhttp://localhost:{port}\033[0m
\033[38;2;0;217;255m→\033[0m Press \033[1mCtrl+C\033[0m to stop

""")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n\033[38;2;0;217;255m→\033[0m Server stopped")
            sys.exit(0)

if __name__ == "__main__":
    main()
