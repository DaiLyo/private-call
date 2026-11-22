
const http = require('http')
const crypto = require('crypto')
const { Server } = require('socket.io')

const PORT = process.env.PORT || 3001
const OWNER_PASSWORD = process.env.OWNER_PASSWORD
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173'

if (!OWNER_PASSWORD || OWNER_PASSWORD.length < 12) {
  console.error(
    'ERROR: Set OWNER_PASSWORD to a password of at least 12 characters before starting the server.',
  )
  process.exit(1)
}

const server = http.createServer()

const io = new Server(server, {
  cors: {
    origin: CLIENT_ORIGIN,
    methods: ['GET', 'POST'],
  },
})

const rooms = new Map()

function safeCompare(a, b) {
  const first = crypto.createHash('sha256').update(a).digest()
  const second = crypto.createHash('sha256').update(b).digest()
  return crypto.timingSafeEqual(first, second)
}

function hashPasscode(passcode, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(passcode, salt, 64).toString('hex')
  return { salt, hash }
}

function verifyPasscode(passcode, stored) {
  const attempted = crypto.scryptSync(passcode, stored.salt, 64)
  const original = Buffer.from(stored.hash, 'hex')

  return (
    attempted.length === original.length &&
    crypto.timingSafeEqual(attempted, original)
  )
}

function makeRoomId() {
  let id

  do {
    id = crypto.randomBytes(4).toString('hex').toUpperCase()
  } while (rooms.has(id))

  return id
}

function removeFromRoom(socket) {
  const roomId = socket.data.roomId
  if (!roomId) return

  const room = rooms.get(roomId)

  if (room) {
    if (socket.id === room.hostId) {
      socket.to(roomId).emit('room-closed')
      rooms.delete(roomId)
    } else {
      room.members.delete(socket.id)
      socket.to(roomId).emit('peer-left')

      if (room.members.size === 0) {
        rooms.delete(roomId)
      }
    }
  }

  socket.leave(roomId)
  socket.data.roomId = null
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id)

  // Owner authentication
  socket.on('owner-login', ({ password } = {}) => {
    if (typeof password !== 'string' || !safeCompare(password, OWNER_PASSWORD)) {
      socket.emit('owner-login-error', 'Incorrect owner password.')
      return
    }

    socket.data.isOwner = true
    socket.emit('owner-authenticated')

    console.log('Owner authenticated:', socket.id)
  })

  // Only an authenticated owner can create rooms
  socket.on('create-room', ({ roomName, passcode } = {}) => {
    if (socket.data.isOwner !== true) {
      socket.emit('room-error', 'Only the room owner can create rooms.')
      return
    }

    if (socket.data.roomId) {
      removeFromRoom(socket)
    }

    if (
      typeof passcode !== 'string' ||
      passcode.length < 4 ||
      passcode.length > 64
    ) {
      socket.emit('room-error', 'Passcode must be between 4 and 64 characters.')
      return
    }

    const roomId = makeRoomId()
    const credentials = hashPasscode(passcode)

    const room = {
      name:
        typeof roomName === 'string' && roomName.trim()
          ? roomName.trim().slice(0, 50)
          : 'Private room',
      passcode: credentials,
      hostId: socket.id,
      members: new Set([socket.id]),
    }

    rooms.set(roomId, room)
    socket.join(roomId)
    socket.data.roomId = roomId

    console.log(`Room ${roomId} created by owner ${socket.id}`)

    socket.emit('room-created', {
      roomId,
      roomName: room.name,
    })
  })

  // Guests can join with a room ID and passcode
  socket.on('join-room', ({ roomId, passcode } = {}) => {
    if (socket.data.roomId) {
      removeFromRoom(socket)
    }

    if (typeof roomId !== 'string' || typeof passcode !== 'string') {
      socket.emit('room-error', 'Enter a room ID and passcode.')
      return
    }

    const cleanId = roomId.trim().toUpperCase()
    const room = rooms.get(cleanId)

    if (!room) {
      socket.emit('room-error', 'Room not found or no longer available.')
      return
    }

    if (!verifyPasscode(passcode, room.passcode)) {
      socket.emit('room-error', 'Incorrect passcode.')
      return
    }

    if (room.members.size >= 2) {
      socket.emit('room-full')
      return
    }

    room.members.add(socket.id)
    socket.join(cleanId)
    socket.data.roomId = cleanId

    socket.emit('joined-room', {
      roomId: cleanId,
      roomName: room.name,
      userCount: room.members.size,
    })

    if (room.members.size === 2) {
      socket.to(cleanId).emit('peer-ready')
    }

    console.log(`User ${socket.id} joined room ${cleanId}`)
  })

  socket.on('offer', ({ roomId, offer } = {}) => {
    if (socket.data.roomId === roomId) {
      socket.to(roomId).emit('offer', offer)
    }
  })

  socket.on('answer', ({ roomId, answer } = {}) => {
    if (socket.data.roomId === roomId) {
      socket.to(roomId).emit('answer', answer)
    }
  })

  socket.on('ice-candidate', ({ roomId, candidate } = {}) => {
    if (socket.data.roomId === roomId) {
      socket.to(roomId).emit('ice-candidate', candidate)
    }
  })

  socket.on('leave-room', () => {
    removeFromRoom(socket)
  })

  socket.on('disconnect', () => {
    removeFromRoom(socket)
    console.log('User disconnected:', socket.id)
  })
})

server.listen(PORT, () => {
  console.log(`PrivateCall signaling server running on port ${PORT}`)
})
