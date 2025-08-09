const fs = require("fs");
const express = require('express');
const bodyParser = require('body-parser');
const session = require("express-session");
const WebSocket = require('ws');
const https = require('https');
const http = require('http');
const app = express();

// importing settings from settings.json
const settings = JSON.parse(fs.readFileSync("settings.json"));

// Create HTTPS server if SSL certificates are available
let server;
let protocol = 'http';

try {
	// Try to load SSL certificates
	const sslOptions = {
		key: fs.readFileSync(settings.ssl_key_path || './ssl/private-key.pem'),
		cert: fs.readFileSync(settings.ssl_cert_path || './ssl/certificate.pem')
	};
	
	server = https.createServer(sslOptions, app);
	protocol = 'https';
	console.log('SSL certificates loaded successfully - using HTTPS');
} catch (error) {
	console.log('SSL certificates not found or invalid - falling back to HTTP');
	console.log('To enable HTTPS, add ssl_key_path and ssl_cert_path to settings.json');
	server = http.createServer(app);
}

// creating the server web socket with proper protocol
const wss = new WebSocket.Server({
	server: server
});

// server variables and video state
const THRESH_IGNORANCE = 250;
let users_amount = 0;
let unique_id = 0; 	
let state = {
	video_timestamp: 0,
	last_updated: get_time(),
	playing: false,
	global_timestamp: 0,
	client_uid: null
};

wss.on('connection', function connection(ws, req) {
	// on connection from client send update
	users_amount += 1;
	console.log('A new client Connected. Amount of users: ', users_amount);
	state.client_uid = unique_id;
	unique_id += 1;
	ws.send(`state_update_from_server ${JSON.stringify(state)}`);

	// log web socket error
	ws.on('error', console.error);

	ws.on('message', function message(data) {
		data = data.toString();

		// syncing requests from the client
		if (data.startsWith("time_sync_request_backward")) {
			ws.send(`time_sync_response_backward ${get_time()}`);
		}
		if (data.startsWith("time_sync_request_forward")) {
			let client_time = Number(data.slice("time_sync_request_forward".length + 1));
			ws.send(`time_sync_response_forward ${get_time() - client_time}`);
		}
		// video state update from client. Update state and broadcast to all users
		if (data.startsWith("state_update_from_client")) {
			let new_state = JSON.parse(data.slice("state_update_from_client".length + 1));
			let too_soon = (get_time() - state.last_updated) < THRESH_IGNORANCE;
			let other_ip = (new_state.client_uid != state.client_uid);
			let stale = (new_state.last_updated < state.last_updated)

			// checking if we should update, in order not to update too much
			if (!stale && !(too_soon && other_ip)) {
				state = new_state;
				
				// broadcasting to all other clients the new state
				wss.clients.forEach(function each(client) {
					if (client !== ws && client.readyState === WebSocket.OPEN) {
						client.send(`state_update_from_server ${JSON.stringify(state)}`);
					}
				});
			}
		}
	});

	// client disconnect
	ws.on('close', function close() {
		users_amount -= 1;
		console.log('Client diconnected. Amount of users: ', users_amount);
	});

});

////  Web server  ////

// HTTPS redirect middleware (only if running HTTPS)
if (protocol === 'https' && settings.force_https !== false) {
	// Create HTTP server for redirecting to HTTPS
	const httpApp = express();
	httpApp.use((req, res) => {
		const httpsUrl = `https://${req.get('host')}${req.url}`;
		res.redirect(301, httpsUrl);
	});
	
	const httpServer = http.createServer(httpApp);
	httpServer.listen(settings.http_port || 80, () => {
		console.log(`HTTP redirect server running on port ${settings.http_port || 80}`);
	});
}

// Security headers for HTTPS
app.use((req, res, next) => {
	if (protocol === 'https') {
		// HTTPS security headers
		res.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
		res.header('X-Frame-Options', 'SAMEORIGIN');
		res.header('X-Content-Type-Options', 'nosniff');
		res.header('X-XSS-Protection', '1; mode=block');
		res.header('Referrer-Policy', 'strict-origin-when-cross-origin');
	}
	next();
});

// app settings
app.use('/', express.static(__dirname));
app.use(bodyParser.urlencoded({
	extended: true
}));
app.use(bodyParser.json());

// Enhanced session configuration for HTTPS
app.use(session({
	secret: settings.session_secret || 'your-secure-secret-key-change-this',
	resave: false,
	saveUninitialized: false,
	logged: false,
	cookie: {
		secure: protocol === 'https', // Only send cookies over HTTPS
		httpOnly: true, // Prevent XSS attacks
		maxAge: 24 * 60 * 60 * 1000 // 24 hours
	}
}));

// iOS-specific middleware for CORS and headers
app.use((req, res, next) => {
	// Enable CORS for iOS WebKit
	res.header('Access-Control-Allow-Origin', settings.cors_origin || '*');
	res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
	res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
	res.header('Access-Control-Allow-Credentials', 'true');
	
	// iOS Safari specific headers
	res.header('Accept-Ranges', 'bytes');
	res.header('Cache-Control', 'no-cache');
	
	next();
});

// Handle OPTIONS requests for CORS
app.options('*', (req, res) => {
	res.sendStatus(200);
});

// home page
app.get("/", function (req, res) {
	if (req.session.logged)
		res.sendFile(__dirname + "/main.html");
	else
		res.sendFile(__dirname + "/login.html");
});

// receive login info
app.post("/login", function (req, res) {
	const data = req.body;
	if (!data)
		res.sendStatus(400);
	else
	{
		if (data.password == settings.password)
			req.session.logged = true;
		else
			req.session.logged = false;
	
		res.redirect("/");
	}
});

// video streaming with iOS compatibility and HTTPS support
app.get("/video", function (req, res) {
	// Check if user is logged in
	if (!req.session.logged) {
		return res.status(401).send("Unauthorized");
	}

	const videoPath = settings.video_path;
	
	// Check if file exists
	if (!fs.existsSync(videoPath)) {
		return res.status(404).send("Video file not found");
	}
	
	const stat = fs.statSync(videoPath);
	const fileSize = stat.size;
	const range = req.headers.range;

	// iOS Safari requires proper range handling
	if (range) {
		// Parse range header
		const parts = range.replace(/bytes=/, "").split("-");
		const start = parseInt(parts[0], 10);
		const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
		
		// Validate range
		if (start >= fileSize || end >= fileSize) {
			res.status(416).send('Requested range not satisfiable\n' + start + ' >= ' + fileSize);
			return;
		}
		
		const chunksize = (end - start) + 1;
		const file = fs.createReadStream(videoPath, { start, end });
		const head = {
			'Content-Range': `bytes ${start}-${end}/${fileSize}`,
			'Accept-Ranges': 'bytes',
			'Content-Length': chunksize,
			'Content-Type': 'video/mp4',
			// iOS specific headers
			'Cache-Control': 'no-cache, no-store, must-revalidate',
			'Pragma': 'no-cache',
			'Expires': '0'
		};
		
		res.writeHead(206, head);
		file.pipe(res);
	} else {
		// For iOS, we should always support range requests
		// If no range is specified, send the first chunk
		const head = {
			'Content-Length': fileSize,
			'Content-Type': 'video/mp4',
			'Accept-Ranges': 'bytes',
			// iOS specific headers
			'Cache-Control': 'no-cache, no-store, must-revalidate',
			'Pragma': 'no-cache',
			'Expires': '0'
		};
		
		res.writeHead(200, head);
		
		// For iOS compatibility, send the entire file if no range specified
		const stream = fs.createReadStream(videoPath);
		stream.pipe(res);
	}
});

// Health check endpoint
app.get("/ping", function (req, res) {
	res.json({ 
		status: "ok", 
		timestamp: get_time(),
		protocol: protocol,
		secure: protocol === 'https'
	});
});

// Error handling middleware
app.use((err, req, res, next) => {
	console.error('Server error:', err);
	res.status(500).send('Internal Server Error');
});

// Graceful shutdown
process.on('SIGTERM', () => {
	console.log('SIGTERM received, shutting down gracefully');
	server.close(() => {
		console.log('Server closed');
		process.exit(0);
	});
});

// host server on given ip and port
server.listen(settings.server_port, () => {
	console.log(`${protocol.toUpperCase()} Server started on port ${settings.server_port}`);
	if (protocol === 'https') {
		console.log(`WebSocket (WSS) available at wss://localhost:${settings.server_port}`);
	} else {
		console.log(`WebSocket (WS) available at ws://localhost:${settings.server_port}`);
	}
});

// function to get the current time
function get_time() {
	let d = new Date();
	return d.getTime();
}