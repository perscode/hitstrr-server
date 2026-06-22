const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'playlists.json');

// ── Spotify credentials from environment variables ───────────────────────────
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
  console.warn('WARNING: SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET not set. Playlist fetching will not work until these are added in Railway Variables.');
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── Persistent storage ────────────────────────────────────────────────────────
function loadPlaylists() {
  if (!fs.existsSync(DATA_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (e) { return []; }
}

function savePlaylists(playlists) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(playlists, null, 2));
}

// ── Spotify API helpers ───────────────────────────────────────────────────────
let spotifyToken = null;
let tokenExpiry = 0;

async function getSpotifyToken() {
  if (spotifyToken && Date.now() < tokenExpiry) return spotifyToken;
  const creds = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`Spotify auth failed: ${res.status}`);
  const data = await res.json();
  spotifyToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return spotifyToken;
}

function extractPlaylistId(input) {
  // Handle full URLs like https://open.spotify.com/playlist/6V406vY7zZ8NeaqL9XS0U0?si=...
  const urlMatch = input.match(/playlist\/([a-zA-Z0-9]+)/);
  if (urlMatch) return urlMatch[1];
  // Handle plain IDs
  if (/^[a-zA-Z0-9]+$/.test(input.trim())) return input.trim();
  return null;
}

// Original release year corrections (common remasters/compilations)
const YEAR_CORRECTIONS = {
  // Add known corrections here if needed
};

async function fetchPlaylistFromSpotify(playlistId) {
  const token = await getSpotifyToken();

  // Fetch playlist metadata
  const metaRes = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}?fields=name,description,images`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!metaRes.ok) throw new Error(`Playlist not found or not public (${metaRes.status})`);
  const meta = await metaRes.json();

  // Fetch all tracks (paginated — Spotify returns max 100 per request)
  const tracks = [];
  let url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100&fields=next,items(track(id,name,artists,album(release_date)))`;

  while (url) {
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Failed to fetch tracks: ${res.status}`);
    const data = await res.json();

    for (const item of data.items) {
      const track = item.track;
      if (!track || !track.id) continue;

      // Parse year from release date (can be YYYY, YYYY-MM, or YYYY-MM-DD)
      const rawDate = track.album?.release_date || '';
      const year = parseInt(rawDate.substring(0, 4)) || 0;

      tracks.push({
        id: track.id,
        title: track.name,
        artist: track.artists.map(a => a.name).join(' & '),
        year: YEAR_CORRECTIONS[track.id] || year,
      });
    }
    url = data.next || null;
  }

  return {
    spotifyId: playlistId,
    name: meta.name,
    emoji: '🎵', // default, user can change later
    tracks,
    addedAt: new Date().toISOString(),
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Hitstrr API' });
});

// Get all playlists
app.get('/playlists', (req, res) => {
  const playlists = loadPlaylists();
  res.json(playlists);
});

// Add a playlist by Spotify URL or ID
app.post('/playlists', async (req, res) => {
  const { url, emoji } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

  const playlistId = extractPlaylistId(url);
  if (!playlistId) return res.status(400).json({ error: 'Invalid Spotify playlist URL or ID' });

  // Check for duplicate
  const existing = loadPlaylists();
  if (existing.find(p => p.spotifyId === playlistId)) {
    return res.status(409).json({ error: 'This playlist is already in the game' });
  }

  try {
    const playlist = await fetchPlaylistFromSpotify(playlistId);
    if (emoji) playlist.emoji = emoji;
    if (playlist.tracks.length === 0) {
      return res.status(400).json({ error: 'Playlist has no playable tracks' });
    }
    const playlists = [...existing, playlist];
    savePlaylists(playlists);
    res.json({ success: true, playlist });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update playlist emoji
app.patch('/playlists/:id', (req, res) => {
  const { emoji } = req.body;
  const playlists = loadPlaylists();
  const idx = playlists.findIndex(p => p.spotifyId === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Playlist not found' });
  if (emoji) playlists[idx].emoji = emoji;
  savePlaylists(playlists);
  res.json(playlists[idx]);
});

// Delete a playlist
app.delete('/playlists/:id', (req, res) => {
  const playlists = loadPlaylists();
  const filtered = playlists.filter(p => p.spotifyId !== req.params.id);
  if (filtered.length === playlists.length) return res.status(404).json({ error: 'Playlist not found' });
  savePlaylists(filtered);
  res.json({ success: true });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Hitstrr server running on port ${PORT}`);
});
