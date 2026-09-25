// Where the dashboard keeps its data.
//
//   "php"      - the PHP + MySQL API in the api/ folder, on your own hosting
//                (e.g. Hostinger). Fill in api/config.php on the server.
//   "supabase" - Supabase. Paste your Project URL and anon public key below
//                (Supabase dashboard -> Project Settings -> API) and run
//                supabase/schema.sql once.
//   "local"    - this browser only, for trying the dashboard out.
window.SOP_CONFIG = {
  backend: "php",
  apiUrl: "api/index.php",

  supabaseUrl: "",
  supabaseAnonKey: "",
};
