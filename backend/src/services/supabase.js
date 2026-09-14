const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

// Node 20 has no built-in WebSocket global; supabase-js needs one even though
// this app never uses realtime subscriptions.
if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = WebSocket;
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

module.exports = supabase;
