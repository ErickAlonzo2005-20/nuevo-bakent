require('dotenv').config();
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const mysql = require('mysql2');

const app = express();

// Se alinea a process.env.PORT o usa 3000 por defecto para hacer match con el proxy de Railway
const PORT = process.env.PORT || 3000;

// Configuración de CORS habilitada para permitir peticiones desde Vercel
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// ================= 1. CONFIGURACIÓN DE SQLITE (Respaldo) =================
const sqliteDB = new sqlite3.Database('./pedidos_local.db', (err) => {
    if (err) console.error("Error en SQLite local:", err.message);
    else console.log("✅ Conectado a SQLite Local exitosamente.");
});

sqliteDB.run(`
CREATE TABLE IF NOT EXISTS pedidos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mesa TEXT,
    mesero TEXT,
    nombreCliente TEXT,
    items TEXT,
    estadoCocina TEXT,
    estadoBar TEXT,
    estadoEntrega TEXT,
    facturado INTEGER DEFAULT 0,
    ncf TEXT,
    hora TEXT,
    fecha TEXT DEFAULT CURRENT_TIMESTAMP
)
`);

// ================= 2. CONFIGURACIÓN DE MYSQL (Railway / XAMPP) =================
const mysqlConnection = mysql.createConnection({
    host: process.env.MYSQLHOST || process.env.DB_HOST || 'localhost',
    user: process.env.MYSQLUSER || process.env.DB_USER || 'root',
    password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD || '',
    database: process.env.MYSQLDATABASE || process.env.DB_DATABASE || process.env.DB_NAME || 'restomanager_db',
    port: process.env.MYSQLPORT || process.env.DB_PORT || 3306,
});

let usandoMySQL = true;

mysqlConnection.connect((err) => {
    if (err) {
        console.log("⚠️ MySQL no disponible. Activando modo OFFLINE con SQLite.");
        console.log("Detalle del error MySQL:", err.message);
        usandoMySQL = false;
    } else {
        console.log("🟢 Conectado exitosamente a la base de datos MySQL.");
        mysqlConnection.query(`
        CREATE TABLE IF NOT EXISTS pedidos (
            id INT AUTO_INCREMENT PRIMARY KEY,
            mesa VARCHAR(50),
            mesero VARCHAR(100),
            nombreCliente VARCHAR(100),
            items LONGTEXT,
            estadoCocina VARCHAR(20),
            estadoBar VARCHAR(20),
            estadoEntrega VARCHAR(20),
            facturado BOOLEAN DEFAULT FALSE,
            ncf VARCHAR(50),
            hora VARCHAR(20),
            fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        `);
    }
});

// Endpoint de prueba de salud
app.get('/', (req, res) => {
    res.send("Backend de RestoManager funcionando correctamente 🚀");
});

// ================= 3. ENTRADAS DE LA API REST (ENDPOINTS) =================

// GET: Obtener todos los pedidos
app.get('/api/pedidos', (req, res) => {
    if (usandoMySQL) {
        mysqlConnection.query(
            "SELECT * FROM pedidos ORDER BY id DESC",
            (err, rows) => {
                if (err) {
                    console.error("❌ Error al obtener pedidos de MySQL:", err);
                    return res.status(500).json({ error: err.message });
                }
                const pedidos = rows.map(pedido => ({
                    ...pedido,
                    items: pedido.items ? JSON.parse(pedido.items) : []
                }));
                res.json(pedidos);
            }
        );
    } else {
        sqliteDB.all(
            "SELECT * FROM pedidos ORDER BY id DESC",
            [],
            (err, rows) => {
                if (err) {
                    console.error("❌ Error al obtener pedidos de SQLite:", err);
                    return res.status(500).json({ error: err.message });
                }
                const pedidos = rows.map(pedido => ({
                    ...pedido,
                    items: pedido.items ? JSON.parse(pedido.items) : []
                }));
                res.json(pedidos);
            }
        );
    }
});

// POST: Registrar un nuevo pedido
app.post('/api/pedidos', (req, res) => {
    console.log("📥 Petición recibida en /api/pedidos con datos:", req.body);

    const {
        mesa = 'Mesa 1',
        mesero = 'Mesero',
        nombreCliente = 'Cliente sin nombre',
        items = [],
        estadoCocina = null,
        estadoBar = null,
        estadoEntrega = 'pendiente',
        facturado = false,
        ncf = null,
        hora = new Date().toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' }),
    } = req.body;

    const itemsJSON = JSON.stringify(items);
    const query = `INSERT INTO pedidos
        (mesa, mesero, nombreCliente, items, estadoCocina, estadoBar, estadoEntrega, facturado, ncf, hora)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const valores = [mesa, mesero, nombreCliente, itemsJSON, estadoCocina, estadoBar, estadoEntrega, facturado ? 1 : 0, ncf, hora];

    if (usandoMySQL) {
        mysqlConnection.query(query, valores, (err, result) => {
            if (err) {
                console.error("❌ Error de inserción en MySQL:", err.message);
                return res.status(500).json({ error: err.message });
            }
            console.log(`✅ ¡Pedido guardado exitosamente en MySQL! ID: ${result.insertId}`);
            res.status(201).json({
                id: result.insertId,
                mesa, mesero, nombreCliente, items, estadoCocina, estadoBar, estadoEntrega, facturado, ncf, hora,
            });
        });
    } else {
        sqliteDB.run(query, valores, function (err) {
            if (err) {
                console.error("❌ Error de inserción en SQLite:", err.message);
                return res.status(500).json({ error: err.message });
            }
            console.log(`✅ Pedido guardado en SQLite (Offline). ID: ${this.lastID}`);
            res.status(201).json({
                id: this.lastID,
                mesa, mesero, nombreCliente, items, estadoCocina, estadoBar, estadoEntrega, facturado, ncf, hora,
            });
        });
    }
});

// PATCH: Actualizar el estado de un pedido
app.patch('/api/pedidos/:id', (req, res) => {
    const { id } = req.params;
    const camposPermitidos = ['estadoCocina', 'estadoBar', 'estadoEntrega', 'facturado', 'ncf'];
    const cambios = Object.keys(req.body).filter(k => camposPermitidos.includes(k));

    if (cambios.length === 0) {
        return res.status(400).json({ error: 'No se enviaron campos válidos para actualizar.' });
    }

    const asignaciones = cambios.map(campo => `${campo} = ?`).join(', ');
    const valores = cambios.map(campo => {
        const v = req.body[campo];
        if (campo === 'facturado') return v ? 1 : 0;
        return v;
    });
    valores.push(id);

    const query = `UPDATE pedidos SET ${asignaciones} WHERE id = ?`;

    const callback = (err) => {
        if (err) {
            console.error("❌ Error al actualizar pedido:", err.message);
            return res.status(500).json({ error: err.message });
        }
        console.log(`✅ Pedido #${id} actualizado:`, req.body);
        res.json({ id, ...req.body });
    };

    if (usandoMySQL) {
        mysqlConnection.query(query, valores, callback);
    } else {
        sqliteDB.run(query, valores, callback);
    }
});

// Escuchar en el puerto dinámico asignado a 0.0.0.0
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor RestoManager corriendo en el puerto ${PORT}`);
});