let mediaRecorder;
let audioChunks = [];
let isRecording = false;

const micBtn = document.getElementById("micBtn");
const textBox = document.getElementById("textBox");
const output = document.getElementById("output");
const savedDiv = document.getElementById("saved");
const project = document.getElementById("project");

// Load saved notes
let notes = JSON.parse(localStorage.getItem("notes") || "[]");
renderSaved();

micBtn.onclick = async () => {
  if (!isRecording) {
    startRecording();
  } else {
    stopRecording();
  }
};

async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  mediaRecorder = new MediaRecorder(stream);
  audioChunks = [];

  mediaRecorder.ondataavailable = e => audioChunks.push(e.data);

  mediaRecorder.onstop = async () => {
    const audioBlob = new Blob(audioChunks);

    // Save raw audio for later (offline-safe)
    const item = {
      audio: audioBlob,
      project: project.value,
      timestamp: Date.now(),
      text: textBox.value || "",
      status: "pending"
    };

    notes.push(item);
    saveNotes();

    // Try STT if online
    if (navigator.onLine) {
      trySpeechToText(item);
    } else {
      textBox.value = "Saved offline (audio only)";
    }

    renderSaved();
  };

  mediaRecorder.start();
  isRecording = true;
  micBtn.classList.add("recording");
  micBtn.innerText = "⏹ Tap to Stop";
}

function stopRecording() {
  mediaRecorder.stop();
  isRecording = false;
  micBtn.classList.remove("recording");
  micBtn.innerText = "🎤 Tap to Record";
}

// Optional browser STT (online only)
function trySpeechToText(item) {
  const recognition = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
  recognition.lang = "en-US";

  recognition.onresult = (event) => {
    const text = event.results[0][0].transcript;
    textBox.value = text;
    item.text = text;
    saveNotes();
    renderSaved();
  };

  recognition.start();
}

async function sendToAI() {
  const res = await fetch("YOUR_WORKER_URL", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: textBox.value,
      project: project.value,
      passcode: localStorage.getItem("passcode")
    })
  });

  const data = await res.json();

  output.innerText = JSON.stringify(data, null, 2);

  // Save structured result
  notes.push({
    ...data,
    status: "done",
    timestamp: Date.now()
  });

  saveNotes();
  renderSaved();
}

function saveNotes() {
  localStorage.setItem("notes", JSON.stringify(notes));
}

function renderSaved() {
  savedDiv.innerText = JSON.stringify(notes, null, 2);
}

// Passcode prompt once
if (!localStorage.getItem("passcode")) {
  const p = prompt("Enter passcode:");
  localStorage.setItem("passcode", p);
}
