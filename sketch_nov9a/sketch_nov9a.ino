#include <SPI.h>
#include <MFRC522.h>
#include "HX711.h"
#include <Servo.h>

// ==========================================
// DEFINISI PIN SESUAI SKEMA BASE SHIELD KAMU
// ==========================================
#define RST_PIN     D0  // GPIO 16 - Baris ke-1 (Paling Atas)
#define HX711_DT    D1  // GPIO 5  - Baris ke-2
#define HX711_SCK   D2  // GPIO 4  - Baris ke-3
#define SERVO_PIN   D3  // GPIO 0  - Baris ke-4
#define SS_PIN      D4  // GPIO 2  - Baris ke-5 (Pin SDA RC522)
// Baris ke-8 (D5=SCK), ke-9 (D6=MISO), ke-10 (D7=MOSI) otomatis diatur SPI
#define MOTOR_IN1   D8  // GPIO 15 - Baris ke-11 (Pin IN2 MX1508 dicolok ke G)

// Inisialisasi Objek
MFRC522 rfid(SS_PIN, RST_PIN);
HX711 scale;
Servo sorterServo;

// Nilai faktor kalibrasi Load Cell (Sesuaikan nanti agar gram-nya akurat)
float calibration_factor = 420.0; 

unsigned long lastWeightTime = 0;

void setup() {
  // 1. Kunci mati motor konveyor sejak detik pertama agar tidak nyelonong saat boot
  pinMode(MOTOR_IN1, OUTPUT);
  digitalWrite(MOTOR_IN1, LOW);

  Serial.begin(115200);
  delay(500);
  Serial.println("\n=============================================");
  Serial.println("   DIAGNOSTIK HARDWARE KONVEYOR OTOMATIS     ");
  Serial.println("=============================================");

  // 2. Inisialisasi Servo SG90 (500us - 2400us agar sudut penuh di ESP8266)
  sorterServo.attach(SERVO_PIN, 500, 2400);
  sorterServo.write(90); // Posisi tengah/netral
  Serial.println("[OK] Servo SG90 siap di posisi 90 derajat.");

  // 3. Inisialisasi SPI & RFID RC522
  SPI.begin();
  rfid.PCD_Init();
  Serial.print("[CEK] Status Modul RFID RC522: ");
  byte v = rfid.PCD_ReadRegister(rfid.VersionReg);
  if ((v == 0x00) || (v == 0xFF)) {
    Serial.println("GAGAL TERBACA! Cek kabel 3.3V, GND, D0, D4, D5, D6, D7.");
  } else {
    Serial.print("TERHUBUNG! (Firmware Version: 0x");
    Serial.print(v, HEX);
    Serial.println(")");
  }

  // 4. Inisialisasi Load Cell HX711
  scale.begin(HX711_DT, HX711_SCK);
  Serial.print("[CEK] Status Modul Load Cell HX711: ");
  if (scale.wait_ready_timeout(1000)) {
    scale.set_scale(calibration_factor);
    scale.tare(); // Nol-kan timbangan saat mulai (pastikan tidak ada beban)
    Serial.println("TERHUBUNG & TARE (0.0 g) BERHASIL!");
  } else {
    Serial.println("GAGAL! Cek kabel 3V, G, DT (D1), dan SCK (D2).");
  }

  Serial.println("---------------------------------------------");
  Serial.println("PERINTAH TES MANUAL (Ketik di Serial Monitor):");
  Serial.println(" [1] Dinamo Konveyor JALAN (Kecepatan Penuh)");
  Serial.println(" [2] Dinamo Konveyor JALAN PELAN (PWM 160)");
  Serial.println(" [0] Dinamo Konveyor BERHENTI");
  Serial.println(" [3] Servo Belok KIRI (45 derajat)");
  Serial.println(" [4] Servo LURUS / TENGAH (90 derajat)");
  Serial.println(" [5] Servo Belok KANAN (135 derajat)");
  Serial.println(" [t] Tare / Reset Timbangan ke 0 gram");
  Serial.println("---------------------------------------------\n");
}

void loop() {
  // --- A. CEK KARTU / TAG RFID ---
  if (rfid.PICC_IsNewCardPresent() && rfid.PICC_ReadCardSerial()) {
    String uidString = "";
    for (byte i = 0; i < rfid.uid.size; i++) {
      if (rfid.uid.uidByte[i] < 0x10) uidString += "0";
      uidString += String(rfid.uid.uidByte[i], HEX);
      if (i < rfid.uid.size - 1) uidString += ":";
    }
    uidString.toUpperCase();
    
    Serial.println("\n>>> [RFID TERDETEKSI] UID Kartu: " + uidString);
    
    rfid.PICC_HaltA();
    rfid.PCD_StopCrypto1();
  }

  // --- B. BACA BERAT LOAD CELL SETIAP 1 DETIK ---
  if (millis() - lastWeightTime >= 1000) {
    lastWeightTime = millis();
    if (scale.is_ready()) {
      float berat = scale.get_units(3); // Rata-rata 3 pembacaan
      long raw = scale.read();          // Nilai mentah ADC
      Serial.print("[HX711] Berat: ");
      Serial.print(berat, 1);
      Serial.print(" gram \t| Raw ADC: ");
      Serial.println(raw);
    } else {
      Serial.println("[HX711] Modul tidak merespons...");
    }
  }

  // --- C. TERIMA PERINTAH TES DARI SERIAL MONITOR ---
  if (Serial.available() > 0) {
    char cmd = Serial.read();
    switch (cmd) {
      case '1':
        digitalWrite(MOTOR_IN1, HIGH);
        Serial.println(">>> [MOTOR] Konveyor JALAN (Full Speed)");
        break;
      case '2':
        analogWrite(MOTOR_IN1, 160); // Rentang PWM ESP8266: 0 - 255
        Serial.println(">>> [MOTOR] Konveyor JALAN PELAN (PWM 160)");
        break;
      case '0':
        digitalWrite(MOTOR_IN1, LOW);
        Serial.println(">>> [MOTOR] Konveyor BERHENTI");
        break;
      case '3':
        sorterServo.write(45);
        Serial.println(">>> [SERVO] Posisi 45 Derajat (Jalur A)");
        break;
      case '4':
        sorterServo.write(90);
        Serial.println(">>> [SERVO] Posisi 90 Derajat (Netral)");
        break;
      case '5':
        sorterServo.write(135);
        Serial.println(">>> [SERVO] Posisi 135 Derajat (Jalur B)");
        break;
      case 't':
      case 'T':
        scale.tare();
        Serial.println(">>> [HX711] Timbangan di-reset ke 0.0 gram (Tare)");
        break;
    }
  }
}