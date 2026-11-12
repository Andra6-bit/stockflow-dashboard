// Isi setelah membuat Firebase Realtime Database.
// Jangan memasukkan private key / database secret ke file ini.
window.STOCKFLOW_CONFIG = {
  databaseURL: "https://stockflow-iot-default-rtdb.asia-southeast1.firebasedatabase.app/",
  // Kosongkan untuk database prototipe dengan rules read terbuka.
  // Untuk deployment aman, gunakan token Firebase Auth yang diperoleh melalui login.
  authToken: "",
  pollIntervalMs: 3000,
  demoMode: false
};