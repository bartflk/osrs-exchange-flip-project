const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(express.json());

//endpoint
app.get("/api/status", (req, res) => {
    res.send("HTTP server running");
});

app.post("/api/flip", (req, res) => {
    console.log("Flip data received:", req.body);

    // Broadcast flip data to all WebSocket clients
    broadcast(JSON.stringify({
        type: "flip_update",
        data: req.body
    }));

    res.send("Flip received");
});

// websocket
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws/flips" });

wss.on("connection", (ws) => {
    console.log("WebSocket client connected");

    ws.send(JSON.stringify({
        type: "connection",
        message: "Connected to OSRS Flip WebSocket"
    }));

    ws.on("message", (msg) => {
        console.log("WS message:", msg);

        // Echo back or handle custom messages
        ws.send(JSON.stringify({
            type: "echo",
            message: msg.toString()
        }));
    });

    ws.on("close", () => {
        console.log("WebSocket client disconnected");
    });
});


//broadcast 
function broadcast(message) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}


//start server
server.listen(8080, () => {
    console.log("HTTP + WebSocket server running on port 8080");
});
