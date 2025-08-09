const vid = document.querySelector('video');

// Determine the correct WebSocket protocol and create connection
const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = `${protocol}//${window.location.hostname}:${window.location.port}`;
console.log('Connecting to WebSocket at:', wsUrl);
const socket = new WebSocket(wsUrl);

// if the new tms is within this margin of the current tms, then the change is ignored for smoother viewing
const PLAYING_THRESH = 1;
const PAUSED_THRESH = 0.01;

// local state
let video_playing = false;
let last_updated = 0;
let client_uid = null;

// clocks sync variables
const num_time_sync_cycles = 10;
let over_estimates = new Array();
let under_estimates = new Array();
let over_estimate = 0;
let under_estimate = 0;
let correction = 0;

// Connection status tracking
let connectionAttempts = 0;
const maxReconnectAttempts = 5;
let reconnectInterval = 1000; // Start with 1 second

// Connection opened
socket.addEventListener('open', function (event) {
	console.log('Connected to WebSocket Server');
	connectionAttempts = 0; // Reset on successful connection
	reconnectInterval = 1000; // Reset reconnect interval
	
	// Start time sync after connection
	setTimeout(() => {
		do_time_sync();
	}, 100);
});

// Got message from the server
socket.addEventListener("message", (event) => {

	// Time syncing backward server-response
	if (event.data.startsWith("time_sync_response_backward")) {
		let time_at_server = Number(event.data.slice("time_sync_response_backward".length + 1));
		let under_estimate_latest = time_at_server - get_global_time(0);

		under_estimates.push(under_estimate_latest);
		under_estimate = median(under_estimates);
		correction = (under_estimate + over_estimate) / 2;

		console.log(`%c Updated val for under_estimate is ${under_estimate}`, "color:green");
		console.log(`%c New correction time is ${correction} milliseconds`, 'color:red; font-size:12px');
	}
	
	// Time syncing forward server-response
	if (event.data.startsWith("time_sync_response_forward")) {
		let calculated_diff = Number(event.data.slice("time_sync_response_forward".length + 1));
		over_estimates.push(calculated_diff);
		over_estimate = median(over_estimates);
		correction = (under_estimate + over_estimate) / 2;

		console.log(`%c Updated val for over_estimate is ${over_estimate}`, "color:green");
		console.log(`%c New correction time is ${correction} milliseconds`, 'color:red; font-size:12px');
	}

	// Video state update from server
	if (event.data.startsWith("state_update_from_server")) {
		let state = JSON.parse(event.data.slice("state_update_from_server".length + 1));

		// Whenever the client connects or reconnects
		if (client_uid == null) {
			client_uid = state.client_uid;
			console.log(`%c Assigned client UID: ${client_uid}`, 'color:blue');
		}

		// calculating the new timestamp for both cases - when the video is playing and when it is paused
		let proposed_time = (state.playing) ? ((get_global_time(correction) - state.global_timestamp) / 1000 + state.video_timestamp) : (state.video_timestamp);
		let gap = Math.abs(proposed_time - vid.currentTime);

		console.log(`%cGap was ${proposed_time - vid.currentTime}`, 'font-size:12px; color:purple');
		if (state.playing) {
			// tolerance while the video is playing
			if (gap > PLAYING_THRESH) {
				vid.currentTime = proposed_time;
			}
			if (vid.paused) {
				vid.play().catch(e => {
					console.warn('Could not auto-play video:', e);
				});
			}
		} else {
			vid.pause();
			// condition to prevent an unnecessary seek
			if (gap > PAUSED_THRESH) {
				vid.currentTime = proposed_time;
			}
		}
	}
});

// Connection error
socket.addEventListener('error', function (event) {
	console.error('WebSocket error:', event);
});

// Connection closed
socket.addEventListener('close', function (event) {
	console.log('Disconnected from WebSocket Server');
	client_uid = null;
	
	// Attempt to reconnect if not intentionally closed
	if (event.code !== 1000 && connectionAttempts < maxReconnectAttempts) {
		connectionAttempts++;
		console.log(`Attempting to reconnect... (${connectionAttempts}/${maxReconnectAttempts})`);
		
		setTimeout(() => {
			window.location.reload(); // Simple reconnection by reloading page
		}, reconnectInterval);
		
		reconnectInterval = Math.min(reconnectInterval * 2, 30000); // Exponential backoff, max 30 seconds
	} else if (connectionAttempts >= maxReconnectAttempts) {
		console.error('Max reconnection attempts reached');
	}
});

// Send video state update to the server
// event: the video event (ex: seeking, pause play) 
function state_change_handler(event) {
	// Check if socket is connected before sending
	if (socket.readyState !== WebSocket.OPEN) {
		console.warn('WebSocket not connected, cannot send state update');
		return;
	}

	if (event !== null && event !== undefined) {
		if (event.type === 'pause')
			video_playing = false;
		else if (event.type === 'play')
			video_playing = true;
	}
	
	last_updated = get_global_time(correction);

	const state_image = {
		video_timestamp: vid.currentTime,
		last_updated: last_updated,
		playing: video_playing,
		global_timestamp: get_global_time(correction),
		client_uid: client_uid
	};

	try {
		socket.send(`state_update_from_client ${JSON.stringify(state_image)}`);
	} catch (error) {
		console.error('Error sending state update:', error);
	}
}

// assigning event handlers
vid.onseeking = state_change_handler;
vid.onplay = state_change_handler;
vid.onpause = state_change_handler;

// handling the video ended case separately
vid.onended = () => {
	video_playing = false;
	last_updated = get_global_time(correction);
	vid.load();
	state_change_handler();
}

// Handle page visibility changes (user switches tabs)
document.addEventListener('visibilitychange', () => {
	if (!document.hidden && socket.readyState !== WebSocket.OPEN) {
		console.log('Page became visible and socket disconnected, attempting to reconnect...');
		setTimeout(() => window.location.reload(), 1000);
	}
});

//// Helper Functions ////

// Get current time with optional delta correction
function get_global_time(delta = 0) {
	let d = new Date();
	return d.getTime() + delta;
}

// Get the saved settings from settings.json
async function get_settings() {
	let s = null;
	try {
		const response = await fetch('/ping'); // Use ping endpoint to check server status
		if (!response.ok) throw new Error('Server not responding');
		
		const settings_response = await fetch('settings.json');
		if (!settings_response.ok) throw new Error('Settings not found');
		
		s = await settings_response.json();
	} catch (error) {
		console.error('Error fetching settings:', error);
	}
	return s;
}

// Find the median of an array
function median(values) {
	if (values.length === 0) {
		return 0;
	}

	values.sort((x, y) => (x - y));
	let half = Math.floor(values.length / 2);
	if (values.length % 2) {
		return values[half];
	}
	return (values[half - 1] + values[half]) / 2.0;
}

// Wait certain given amount of milliseconds
function timeout(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

// Send the backward update request to the server
function do_time_sync_one_cycle_backward() {
	if (socket.readyState === WebSocket.OPEN) {
		socket.send("time_sync_request_backward");
	}
}

// Send the forward update request to the server
function do_time_sync_one_cycle_forward() {
	if (socket.readyState === WebSocket.OPEN) {
		socket.send(`time_sync_request_forward ${get_global_time()}`);
	}
}

// Sync the client and the server, using backward and forward syncing
async function do_time_sync() {
	console.log('Starting time synchronization...');
	
	for (let i = 0; i < num_time_sync_cycles; i++) {
		if (socket.readyState !== WebSocket.OPEN) {
			console.warn('WebSocket disconnected during time sync');
			break;
		}
		
		await timeout(500);
		do_time_sync_one_cycle_backward();
		await timeout(500);
		do_time_sync_one_cycle_forward();
		
		console.log(`Time sync cycle ${i + 1}/${num_time_sync_cycles} completed`);
	}
	
	console.log('Time synchronization completed');
	console.log(`Final correction: ${correction}ms`);
}

// Periodic time sync to maintain accuracy
setInterval(() => {
	if (socket.readyState === WebSocket.OPEN) {
		do_time_sync();
	}
}, 60000); // Re-sync every minute

// Log connection status
console.log(`Client initialized. Protocol: ${protocol}`);
console.log(`WebSocket URL: ${wsUrl}`);