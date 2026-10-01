const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public')); 

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const db = new sqlite3.Database('./database.db', (err) => {
    if (err) console.error("Error membuka database: ", err.message);
    else console.log("✅ Terhubung ke database lokal SQLite.");
});

db.run(`CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_id TEXT,
    start_time TEXT,
    end_time TEXT,
    status TEXT,
    customer_name TEXT,
    customer_wa TEXT,
    total_billed INTEGER DEFAULT 0,
    grand_total INTEGER DEFAULT 0
)`);

const tableScores = {}; 

function isWeekend() {
    const day = new Date().getDay();
    return (day === 0 || day === 5 || day === 6);
}

function calculatePrice(tableId, minutes) {
    const isAuto = tableId.toUpperCase().startsWith('A');
    const weekend = isWeekend();
    let price = 0;

    if (isAuto) {
        if (weekend) {
            if (minutes === 180) price = 299000;
            else if (minutes === 60) price = 119000;
            else if (minutes === 30) price = 119000 / 2;
        } else {
            if (minutes === 180) price = 239000;
            else if (minutes === 60) price = 99000;
            else if (minutes === 30) price = 99000 / 2;
        }
    } else {
        if (weekend) {
            if (minutes === 180) price = 195000;
            else if (minutes === 60) price = 75000;
            else if (minutes === 30) price = 75000 / 2;
        } else {
            if (minutes === 180) price = 165000;
            else if (minutes === 60) price = 65000;
            else if (minutes === 30) price = 65000 / 2;
        }
    }
    return price;
}

const formatRp = (num) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(num);

function kirimWhatsAppBilling(nama, wa, meja, start, end, subtotal, diskon, grandTotal) {
    if (!wa) return;
    const jamMulai = new Date(start).toLocaleTimeString('id-ID', {hour: '2-digit', minute:'2-digit'});
    const jamSelesai = new Date(end).toLocaleTimeString('id-ID', {hour: '2-digit', minute:'2-digit'});
    
    const pesanWA = `
*INVOICE SERU!MAHJONG* 🀄
Halo *${nama}*, terima kasih telah bermain!

*Detail Sesi:*
🀄 Meja: ${meja}
⏰ Mulai: ${jamMulai}
⏳ Selesai: ${jamSelesai}

*Rincian Tagihan:*
💵 Subtotal: ${formatRp(subtotal)}
🎁 Diskon: -${formatRp(diskon)}
----------------------------------
💰 *TOTAL BAYAR: ${formatRp(grandTotal)}*

Waktu bermain telah diselesaikan. Terima kasih!`;

    console.log(`\n💬 [WHATSAPP INVOICE TERKIRIM KE ${wa}]`);
}

setInterval(() => {
    const now = new Date().toISOString();
    db.all(`SELECT * FROM sessions WHERE status = 'active' AND end_time <= ?`, [now], (err, rows) => {
        if (!rows) return;
        rows.forEach(row => {
            const grandTotal = row.total_billed; 
            db.run(`UPDATE sessions SET status = 'completed', grand_total = ? WHERE id = ?`, [grandTotal, row.id], (err) => {
                if (!err) {
                    kirimWhatsAppBilling(row.customer_name, row.customer_wa, row.table_id, row.start_time, row.end_time, row.total_billed, 0, grandTotal);
                    delete tableScores[row.table_id];
                    io.to(`table_${row.table_id}`).emit('timer_update', { status: 'completed' });
                    io.emit('update_dashboard_kasir', { table_id: row.table_id, status: 'completed' });
                }
            });
        });
    });
}, 5000);

// --- ROUTING SPESIFIK AGAR KASIR DAN CUSTOMER TIDAK TERTUKAR ---
app.get('/kasir', (req, res) => { 
    res.sendFile(path.join(__dirname, 'cashier.html')); 
});

app.get('/meja/:id', (req, res) => { 
    res.sendFile(path.join(__dirname, 'customer.html')); 
});

app.get('/api/tables/status', (req, res) => {
    db.all(`SELECT table_id, start_time, end_time, status, customer_name, customer_wa, total_billed FROM sessions WHERE status IN ('active', 'waiting')`, [], (err, rows) => {
        const tableSessions = {};
        rows.forEach(row => {
            tableSessions[row.table_id] = { 
                status: row.status, startTime: row.start_time, endTime: row.end_time,
                customerName: row.customer_name, customerWa: row.customer_wa, totalBilled: row.total_billed
            };
        });
        res.json(tableSessions);
    });
});

app.get('/api/cashier/reports', (req, res) => {
    db.all(`SELECT * FROM sessions ORDER BY id DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/cashier/approve', (req, res) => {
    const { table_id, duration_minutes } = req.body;
    const startTime = new Date();
    const endTime = new Date(startTime.getTime() + duration_minutes * 60000);
    const price = calculatePrice(table_id, duration_minutes);
    
    db.get(`SELECT * FROM sessions WHERE table_id = ? AND status = 'waiting'`, [table_id], (err, row) => {
        if(!row) return res.status(400).json({ error: "Tidak ada antrean waiting di meja ini." });

        db.run(`UPDATE sessions SET start_time = ?, end_time = ?, status = 'active', total_billed = ? WHERE id = ?`, 
        [startTime.toISOString(), endTime.toISOString(), price, row.id], function(err) {
            const sessionData = { 
                status: 'active', startTime: startTime.toISOString(), endTime: endTime.toISOString(), 
                requires_login: false, customerName: row.customer_name, customerWa: row.customer_wa, totalBilled: price 
            };
            io.to(`table_${table_id}`).emit('timer_update', sessionData);
            io.emit('update_dashboard_kasir', { table_id: table_id, ...sessionData });
            res.json({ message: `Meja ${table_id} berhasil diapprove.` });
        });
    });
});

app.post('/api/cashier/extend', (req, res) => {
    const { table_id, added_minutes } = req.body;
    db.get(`SELECT * FROM sessions WHERE table_id = ? AND status = 'active'`, [table_id], (err, row) => {
        if (!row) return res.status(400).json({ error: 'Meja tidak aktif.' });
        
        const newEndTime = new Date(new Date(row.end_time).getTime() + added_minutes * 60000);
        const additionalPrice = calculatePrice(table_id, added_minutes);
        const newTotalBilled = row.total_billed + additionalPrice;

        db.run(`UPDATE sessions SET end_time = ?, total_billed = ? WHERE id = ?`, [newEndTime.toISOString(), newTotalBilled, row.id], function(err) {
            const sessionData = { status: 'active', startTime: row.start_time, endTime: newEndTime.toISOString(), customerName: row.customer_name, totalBilled: newTotalBilled };
            io.to(`table_${table_id}`).emit('timer_update', sessionData);
            io.emit('update_dashboard_kasir', { table_id: table_id, ...sessionData });
            res.json({ message: 'Waktu ditambah.' });
        });
    });
});

app.post('/api/cashier/checkout', (req, res) => {
    const { table_id, diskon } = req.body;
    db.get(`SELECT * FROM sessions WHERE table_id = ? AND status = 'active'`, [table_id], (err, row) => {
        if (row) {
            const subtotal = row.total_billed;
            const grandTotal = subtotal - (diskon || 0);

            db.run(`UPDATE sessions SET status = 'completed', grand_total = ? WHERE id = ?`, [grandTotal, row.id], function(err) {
                kirimWhatsAppBilling(row.customer_name, row.customer_wa, row.table_id, row.start_time, row.end_time, subtotal, diskon, grandTotal);
                
                delete tableScores[table_id];
                io.to(`table_${table_id}`).emit('timer_update', { status: 'completed' });
                io.emit('update_dashboard_kasir', { table_id: table_id, status: 'completed' });
                
                res.json({ 
                    message: `Checkout berhasil.`,
                    receipt: {
                        table_id: row.table_id, customer_name: row.customer_name || 'Pelanggan',
                        start_time: row.start_time, end_time: row.end_time,
                        subtotal: subtotal, discount: diskon, grand_total: grandTotal
                    }
                });
            });
        } else {
            res.json({ error: `Meja sudah kosong.` });
        }
    });
});

io.on('connection', (socket) => {
    socket.on('join_table', (table_id) => {
        socket.join(`table_${table_id}`); 
        db.get(`SELECT * FROM sessions WHERE table_id = ? AND status IN ('active', 'waiting')`, [table_id], (err, row) => {
            if (!row) {
                socket.emit('timer_update', { status: 'completed', requires_login: true });
            } else if (row.status === 'waiting') {
                socket.emit('timer_update', { status: 'waiting', requires_login: false });
            } else {
                socket.emit('timer_update', { status: 'active', startTime: row.start_time, endTime: row.end_time, requires_login: false });
                if (tableScores[table_id]) socket.emit('sync_score', tableScores[table_id]);
            }
        });
    });

    socket.on('submit_login', (data) => {
        db.get(`SELECT * FROM sessions WHERE table_id = ? AND status IN ('active', 'waiting')`, [data.table_id], (err, row) => {
            if(row) {
                db.run(`UPDATE sessions SET customer_name = ?, customer_wa = ?, status = 'waiting' WHERE id = ?`, [data.name, data.wa, row.id], function(err) {
                    afterLoginSent(data.table_id);
                });
            } else {
                db.run(`INSERT INTO sessions (table_id, status, customer_name, customer_wa) VALUES (?, 'waiting', ?, ?)`, [data.table_id, data.name, data.wa], function(err) {
                    afterLoginSent(data.table_id);
                });
            }
        });
    });

    function afterLoginSent(table_id) {
        db.get(`SELECT * FROM sessions WHERE table_id = ? AND status = 'waiting'`, [table_id], (err, row) => {
            if(row) {
                const sessionData = { status: 'waiting', customerName: row.customer_name, customerWa: row.customer_wa, requires_login: false };
                io.to(`table_${table_id}`).emit('timer_update', sessionData);
                io.emit('update_dashboard_kasir', { table_id: table_id, ...sessionData });

                if (!tableScores[table_id]) {
                    tableScores[table_id] = { n1: row.customer_name, w1: 0, n2: "Pemain 2", w2: 0, n3: "Pemain 3", w3: 0, n4: "Pemain 4", w4: 0 };
                } else { tableScores[table_id].n1 = row.customer_name; }
                io.to(`table_${table_id}`).emit('sync_score', tableScores[table_id]);
            }
        });
    }

    socket.on('call_staff', (data) => {
        io.emit('staff_alert', { table_id: data.table_id, customer_name: data.customer_name });
    });

    socket.on('kasir_sync_tick', (data) => { io.to(`table_${data.table_id}`).emit('sync_timer_display', data.time_text); });
    socket.on('update_score', (data) => { tableScores[data.table_id] = data.scores; socket.to(`table_${data.table_id}`).emit('sync_score', data.scores); });
});

server.listen(3000, '0.0.0.0', () => { console.log('✅ Server berjalan di port 3000'); });