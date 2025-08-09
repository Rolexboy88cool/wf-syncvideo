const vid = document.querySelector('video');

// Determine the correct WebSocket protocol and create connection
const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = `${protocol}//${window.location.hostname}:${window.location.port}`;
console.log('Connecting to WebSocket at:', wsUrl);
const socket = new WebSocket(wsUrl);

// iOS Detection
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || 
             (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

console.log(`Device detection - iOS: ${isIOS}, Safari: ${isSafari}`);

// Adjusted thresholds for iOS
const PLAYING_THRESH = isIOS ? 2.5 : 1;
const PAUSED_THRESH = isIOS ? 0.5 : 0.01;

// local state
let video_playing = false;
let last_updated = 0;
let client_uid = null;
let userHasInteracted = false;
let videoCanSeek = false;
let pendingSeek = null;
let isBuffering = false;
let localVideoState = 'paused'; // Track our local state separately
let ignoreNextEvent = false; // Flag to ignore events we trigger

// Sync status tracking
let lastSyncTime = 0;
let syncStatus = 'disconnected'; // 'synced', 'out_of_sync', 'disconnected', 'syncing'
let currentGap = 0;

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
let reconnectInterval = 1000;

// Create UI elements
function createSyncUI() {
    // Container for sync controls
    const syncContainer = document.createElement('div');
    syncContainer.id = 'sync-container';
    syncContainer.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 10000;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        display: flex;
        flex-direction: column;
        gap: 10px;
        max-width: 200px;
    `;

    // Status indicator
    const statusIndicator = document.createElement('div');
    statusIndicator.id = 'sync-status';
    statusIndicator.style.cssText = `
        padding: 8px 12px;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 600;
        text-align: center;
        color: white;
        background: #6c757d;
        box-shadow: 0 2px 8px rgba(0,0,0,0.2);
        transition: all 0.3s ease;
    `;
    statusIndicator.textContent = 'Disconnected';

    // Re-sync button
    const resyncButton = document.createElement('button');
    resyncButton.id = 'resync-button';
    resyncButton.textContent = '🔄 Re-sync';
    resyncButton.style.cssText = `
        padding: 8px 16px;
        border: none;
        border-radius: 6px;
        background: #007AFF;
        color: white;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        box-shadow: 0 2px 8px rgba(0,0,0,0.2);
        transition: all 0.2s ease;
    `;
    
    resyncButton.addEventListener('mouseenter', () => {
        resyncButton.style.background = '#0056CC';
        resyncButton.style.transform = 'translateY(-1px)';
    });
    
    resyncButton.addEventListener('mouseleave', () => {
        resyncButton.style.background = '#007AFF';
        resyncButton.style.transform = 'translateY(0)';
    });

    resyncButton.onclick = () => {
        console.log('Manual re-sync requested');
        updateSyncStatus('syncing');
        do_time_sync();
        // Force a state update
        if (socket.readyState === WebSocket.OPEN) {
            state_change_handler(null);
        }
    };

    syncContainer.appendChild(statusIndicator);
    syncContainer.appendChild(resyncButton);
    document.body.appendChild(syncContainer);

    return { statusIndicator, resyncButton, syncContainer };
}

// Update sync status display
function updateSyncStatus(status, gap = null) {
    const statusElement = document.getElementById('sync-status');
    if (!statusElement) return;

    syncStatus = status;
    if (gap !== null) currentGap = gap;

    let statusText = '';
    let backgroundColor = '';

    switch (status) {
        case 'synced':
            statusText = '✅ Synced';
            backgroundColor = '#28a745';
            break;
        case 'out_of_sync':
            statusText = `⚠️ Out of Sync (${Math.abs(currentGap).toFixed(1)}s)`;
            backgroundColor = '#ffc107';
            break;
        case 'disconnected':
            statusText = '❌ Disconnected';
            backgroundColor = '#dc3545';
            break;
        case 'syncing':
            statusText = '🔄 Syncing...';
            backgroundColor = '#17a2b8';
            break;
        case 'buffering':
            statusText = '⏳ Buffering';
            backgroundColor = '#6f42c1';
            break;
        default:
            statusText = '❓ Unknown';
            backgroundColor = '#6c757d';
    }

    statusElement.textContent = statusText;
    statusElement.style.background = backgroundColor;
    lastSyncTime = Date.now();
}

// Initialize UI
const syncUI = createSyncUI();

// Monitor sync status
function checkSyncStatus() {
    if (socket.readyState !== WebSocket.OPEN) {
        updateSyncStatus('disconnected');
        return;
    }

    if (isBuffering) {
        updateSyncStatus('buffering');
        return;
    }

    // Check if we've received updates recently
    const timeSinceLastUpdate = Date.now() - lastSyncTime;
    if (timeSinceLastUpdate > 10000) { // 10 seconds without updates
        updateSyncStatus('out_of_sync', currentGap);
        return;
    }

    // Determine sync status based on current gap
    if (Math.abs(currentGap) <= (video_playing ? PLAYING_THRESH : PAUSED_THRESH)) {
        updateSyncStatus('synced', currentGap);
    } else {
        updateSyncStatus('out_of_sync', currentGap);
    }
}

// Run sync status check every 2 seconds
setInterval(checkSyncStatus, 2000);

// iOS-specific video event handlers
vid.addEventListener('loadedmetadata', () => {
    console.log('Video metadata loaded');
    videoCanSeek = true;
    if (pendingSeek !== null) {
        attemptSeek(pendingSeek);
        pendingSeek = null;
    }
});

vid.addEventListener('canplay', () => {
    console.log('Video can start playing');
    videoCanSeek = true;
});

vid.addEventListener('canplaythrough', () => {
    console.log('Video can play through without buffering');
    isBuffering = false;
    updateSyncStatus('synced');
});

vid.addEventListener('waiting', () => {
    console.log('Video is waiting for more data (buffering)');
    isBuffering = true;
    updateSyncStatus('buffering');
});

vid.addEventListener('stalled', () => {
    console.log('Video download has stalled');
    isBuffering = true;
    updateSyncStatus('buffering');
});

// User interaction detection for iOS autoplay
document.addEventListener('touchstart', () => {
    userHasInteracted = true;
    console.log('User interaction detected via touch');
}, { once: true });

document.addEventListener('click', () => {
    userHasInteracted = true;
    console.log('User interaction detected via click');
}, { once: true });

// iOS-safe seek function
function attemptSeek(targetTime) {
    if (!videoCanSeek || vid.readyState < 2) {
        console.log('Video not ready for seeking, queuing seek request');
        pendingSeek = targetTime;
        return false;
    }

    if (vid.buffered.length > 0) {
        let canSeekToTarget = false;
        for (let i = 0; i < vid.buffered.length; i++) {
            if (targetTime >= vid.buffered.start(i) && targetTime <= vid.buffered.end(i)) {
                canSeekToTarget = true;
                break;
            }
        }
        
        if (!canSeekToTarget && isIOS) {
            console.log('Target time not in buffered range, skipping seek on iOS');
            return false;
        }
    }

    try {
        console.log(`Seeking from ${vid.currentTime} to ${targetTime}`);
        ignoreNextEvent = true;
        vid.currentTime = targetTime;
        return true;
    } catch (error) {
        console.error('Seek failed:', error);
        return false;
    }
}

// iOS-safe play function
async function attemptPlay() {
    if (!userHasInteracted && isIOS) {
        console.log('iOS requires user interaction before play');
        return false;
    }

    try {
        ignoreNextEvent = true;
        localVideoState = 'playing';
        await vid.play();
        console.log('Video play succeeded');
        return true;
    } catch (error) {
        console.error('Play failed:', error);
        localVideoState = 'paused';
        if (error.name === 'NotAllowedError') {
            console.log('Play blocked by browser - user interaction required');
        }
        return false;
    }
}

// iOS-safe pause function
function attemptPause() {
    try {
        ignoreNextEvent = true;
        localVideoState = 'paused';
        vid.pause();
        console.log('Video pause succeeded');
        return true;
    } catch (error) {
        console.error('Pause failed:', error);
        return false;
    }
}

// Force sync video state
function forceVideoState(shouldPlay) {
    console.log(`Force video state: ${shouldPlay ? 'play' : 'pause'}, current paused: ${vid.paused}`);
    
    if (shouldPlay && vid.paused) {
        console.log('Video should be playing but is paused - attempting play');
        attemptPlay();
    } else if (!shouldPlay && !vid.paused) {
        console.log('Video should be paused but is playing - attempting pause');
        attemptPause();
    }
}

// Connection opened
socket.addEventListener('open', function (event) {
    console.log('Connected to WebSocket Server');
    connectionAttempts = 0;
    reconnectInterval = 1000;
    updateSyncStatus('syncing');
    
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

        // Skip updates from our own client
        if (state.client_uid === client_uid) {
            console.log('Ignoring update from own client');
            return;
        }

        // Skip updates if we're buffering on iOS
        if (isBuffering && isIOS) {
            console.log('Skipping sync update due to buffering on iOS');
            return;
        }

        console.log(`%c Received state update: playing=${state.playing}, video_timestamp=${state.video_timestamp}`, 'color:orange');
        console.log(`%c Current video state: paused=${vid.paused}, currentTime=${vid.currentTime}`, 'color:orange');

        // calculating the new timestamp for both cases - when the video is playing and when it is paused
        let proposed_time = (state.playing) ? ((get_global_time(correction) - state.global_timestamp) / 1000 + state.video_timestamp) : (state.video_timestamp);
        let gap = Math.abs(proposed_time - vid.currentTime);
        currentGap = proposed_time - vid.currentTime; // Store signed gap for status display

        console.log(`%cGap was ${proposed_time - vid.currentTime}`, 'font-size:12px; color:purple');
        
        // Update sync status based on gap
        lastSyncTime = Date.now();
        
        // Handle play/pause state first
        if (state.playing && vid.paused) {
            console.log('Server says playing, but video is paused - attempting play');
            if (userHasInteracted || !isIOS) {
                attemptPlay();
            } else {
                console.log('Cannot play - no user interaction on iOS');
            }
        } else if (!state.playing && !vid.paused) {
            console.log('Server says paused, but video is playing - attempting pause');
            attemptPause();
        }

        // Then handle seeking
        if (state.playing) {
            // tolerance while the video is playing
            if (gap > PLAYING_THRESH) {
                console.log(`Gap ${gap}s exceeds threshold ${PLAYING_THRESH}s, attempting seek`);
                attemptSeek(proposed_time);
            }
        } else {
            // condition to prevent an unnecessary seek when paused
            if (gap > PAUSED_THRESH) {
                console.log(`Gap ${gap}s exceeds paused threshold ${PAUSED_THRESH}s, attempting seek`);
                attemptSeek(proposed_time);
            }
        }

        // Force state check after a delay to ensure consistency
        setTimeout(() => {
            forceVideoState(state.playing);
        }, 100);
    }
});

// Connection error
socket.addEventListener('error', function (event) {
    console.error('WebSocket error:', event);
    updateSyncStatus('disconnected');
});

// Connection closed
socket.addEventListener('close', function (event) {
    console.log('Disconnected from WebSocket Server');
    client_uid = null;
    updateSyncStatus('disconnected');
    
    if (event.code !== 1000 && connectionAttempts < maxReconnectAttempts) {
        connectionAttempts++;
        console.log(`Attempting to reconnect... (${connectionAttempts}/${maxReconnectAttempts})`);
        
        setTimeout(() => {
            window.location.reload();
        }, reconnectInterval);
        
        reconnectInterval = Math.min(reconnectInterval * 2, 30000);
    } else if (connectionAttempts >= maxReconnectAttempts) {
        console.error('Max reconnection attempts reached');
    }
});

// Send video state update to the server
function state_change_handler(event) {
    // Ignore events that we triggered programmatically
    if (ignoreNextEvent) {
        ignoreNextEvent = false;
        console.log('Ignoring programmatically triggered event');
        return;
    }

    // Check if socket is connected before sending
    if (socket.readyState !== WebSocket.OPEN) {
        console.warn('WebSocket not connected, cannot send state update');
        updateSyncStatus('disconnected');
        return;
    }

    if (event !== null && event !== undefined) {
        if (event.type === 'pause') {
            video_playing = false;
            localVideoState = 'paused';
        } else if (event.type === 'play') {
            video_playing = true;
            localVideoState = 'playing';
        }
        
        console.log(`Video event: ${event.type}, local state: ${localVideoState}`);
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
        console.log('State update sent:', state_image);
        lastSyncTime = Date.now();
    } catch (error) {
        console.error('Error sending state update:', error);
        updateSyncStatus('disconnected');
    }
}

// assigning event handlers
vid.onseeking = state_change_handler;
vid.onplay = state_change_handler;
vid.onpause = state_change_handler;

// iOS-specific additional handlers
vid.onseeked = () => {
    console.log('Seek completed');
    if (!ignoreNextEvent) {
        state_change_handler({ type: 'seeked' });
    }
};

vid.onloadstart = () => {
    console.log('Video load started');
    videoCanSeek = false;
};

// Additional iOS event handlers for better state tracking
vid.addEventListener('play', () => {
    console.log('Play event fired, video.paused =', vid.paused);
    localVideoState = 'playing';
});

vid.addEventListener('pause', () => {
    console.log('Pause event fired, video.paused =', vid.paused);
    localVideoState = 'paused';
});

// Monitor for state inconsistencies
setInterval(() => {
    if (isIOS) {
        const actualState = vid.paused ? 'paused' : 'playing';
        if (localVideoState !== actualState) {
            console.warn(`State mismatch detected: local=${localVideoState}, actual=${actualState}`);
            localVideoState = actualState;
        }
    }
}, 1000);

// handling the video ended case separately
vid.onended = () => {
    video_playing = false;
    localVideoState = 'paused';
    last_updated = get_global_time(correction);
    vid.load();
    state_change_handler();
}

// Handle page visibility changes
document.addEventListener('visibilitychange', () => {
    if (!document.hidden && socket.readyState !== WebSocket.OPEN) {
        console.log('Page became visible and socket disconnected, attempting to reconnect...');
        setTimeout(() => window.location.reload(), 1000);
    }
});

// Add user interaction button for iOS
if (isIOS && !userHasInteracted) {
    const playButton = document.createElement('button');
    playButton.textContent = '▶️ Tap to Enable Sync';
    playButton.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        z-index: 9999;
        padding: 20px 40px;
        font-size: 18px;
        background: #007AFF;
        color: white;
        border: none;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    `;
    
    playButton.onclick = async () => {
        userHasInteracted = true;
        console.log('User interaction button clicked');
        await attemptPlay();
        playButton.remove();
    };
    
    document.body.appendChild(playButton);
}

//// Helper Functions ////

function get_global_time(delta = 0) {
    let d = new Date();
    return d.getTime() + delta;
}

async function get_settings() {
    let s = null;
    try {
        const response = await fetch('/ping');
        if (!response.ok) throw new Error('Server not responding');
        
        const settings_response = await fetch('settings.json');
        if (!settings_response.ok) throw new Error('Settings not found');
        
        s = await settings_response.json();
    } catch (error) {
        console.error('Error fetching settings:', error);
    }
    return s;
}

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

function timeout(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function do_time_sync_one_cycle_backward() {
    if (socket.readyState === WebSocket.OPEN) {
        socket.send("time_sync_request_backward");
    }
}

function do_time_sync_one_cycle_forward() {
    if (socket.readyState === WebSocket.OPEN) {
        socket.send(`time_sync_request_forward ${get_global_time()}`);
    }
}

async function do_time_sync() {
    console.log('Starting time synchronization...');
    updateSyncStatus('syncing');
    
    for (let i = 0; i < num_time_sync_cycles; i++) {
        if (socket.readyState !== WebSocket.OPEN) {
            console.warn('WebSocket disconnected during time sync');
            updateSyncStatus('disconnected');
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

// Less frequent time sync to reduce iOS issues
setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) {
        do_time_sync();
    }
}, 120000); // Re-sync every 2 minutes

console.log(`Client initialized. Protocol: ${protocol}`);
console.log(`WebSocket URL: ${wsUrl}`);
console.log(`iOS detected: ${isIOS}, User interacted: ${userHasInteracted}`);