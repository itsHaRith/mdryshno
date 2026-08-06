import play from 'play-dl';

async function test() {
  try {
    const query = 'حسين غزال - العواطف';
    console.log('[Test] Getting free SoundCloud Client ID...');
    const clientID = await play.getFreeClientID();
    
    await play.setToken({
      soundcloud: {
        client_id: clientID
      }
    });
    console.log('[Test] SoundCloud Client ID registered:', clientID);

    console.log('[Test] Searching SoundCloud for:', query);
    const scSearch = await play.search(query, { 
      source: { soundcloud: 'tracks' }, 
      limit: 1 
    });

    if (!scSearch || scSearch.length === 0) {
      console.log('[Test] No SoundCloud tracks found.');
      process.exit(1);
    }

    const track = scSearch[0];
    console.log('[Test] Found SoundCloud Track:', track.title);
    console.log('[Test] URL:', track.url);

    console.log('[Test] Attempting SoundCloud stream creation...');
    const stream = await play.stream(track.url);
    console.log('[Test] Stream created successfully! Type:', stream.type);
    process.exit(0);
  } catch (err) {
    console.error('[Test] SoundCloud stream failed:', err.message, err.stack);
    process.exit(1);
  }
}

test();
