import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://yuoxvjxmedhssnpinqne.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl1b3h2anhtZWRoc3NucGlucW5lIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQzMjE4NTYsImV4cCI6MjA4OTg5Nzg1Nn0.cj1T_0tNZLxFpuDVJ5Dw7nfkdioESQvSmRyeUTTiidg";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
