const fs = require("fs");
const express = require('express');
const bodyParser = require('body-parser');
const session = require("express-session");
const WebSocket = require('ws');
const app = express();
const server = require('http').createServer(app);

// creating the server web socket
const wss = new WebSocket.Server({
	server: server
});
// importing settings from settings.json
const settings = JSON.parse(fs.readFileSync("settings.json"));

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

wss.on('connection', function connection(ws) {
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

// app settings
app.use('/', express.static(__dirname));
app.use(bodyParser.urlencoded({
	extended: true
}));
app.use(bodyParser.json());
app.use(session({
	secret: 'secret key',
	resave: false,
	saveUninitialized: false,
	logged: false
}));

// iOS-specific middleware for CORS and headers
app.use((req, res, next) => {
	// Enable CORS for iOS WebKit
	res.header('Access-Control-Allow-Origin', '*');
	res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
	res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
	
	// iOS Safari specific headers
	res.header('Accept-Ranges', 'bytes');
	res.header('Cache-Control', 'no-cache');
	
	next();
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

// video streaming with iOS compatibility
app.get("/video", function (req, res) {
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

// iOS WebSocket ping endpoint for connection health
app.get("/ping", function (req, res) {
	res.json({ status: "ok", timestamp: get_time() });
});

// host server on given ip and port
server.listen(settings.server_port,
	() => console.log(`Server started at:${settings.server_port}`));

// function to get the current time
function get_time() {
	let d = new Date();
	return d.getTime();
}