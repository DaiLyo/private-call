
import { useEffect, useRef, useState } from 'react'
import { io, Socket } from 'socket.io-client'
import './App.css'

const SIGNALING_SERVER = 'https://private-call-70fa.onrender.com'

type RoomMode = 'home' | 'owner-login' | 'create' | 'join'

function App() {
  const localVideoRef = useRef<HTMLVideoElement | null>(null)
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null)

  const socketRef = useRef<Socket | null>(null)
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)

  const hasInviteLink = new URLSearchParams(window.location.search).has('room')

  const [roomId, setRoomId] = useState(
    () => new URLSearchParams(window.location.search).get('room') || '',
  )
  const [roomName, setRoomName] = useState('Private meeting')
  const [ownerPassword, setOwnerPassword] = useState('')
  const [createPasscode, setCreatePasscode] = useState('')
  const [joinPasscode, setJoinPasscode] = useState('')
  const [inviteUrl, setInviteUrl] = useState('')
  const [joined, setJoined] = useState(false)
  const [ownerAuthenticated, setOwnerAuthenticated] = useState(false)
  const [status, setStatus] = useState('Ready to connect')
  const [cameraOn, setCameraOn] = useState(true)
  const [micOn, setMicOn] = useState(true)
  const [cameraError, setCameraError] = useState('')
  const [roomError, setRoomError] = useState('')
  const [roomMode, setRoomMode] = useState<RoomMode>(
    hasInviteLink ? 'join' : 'home',
  )

  useEffect(() => {
    if (!joined || !localStreamRef.current || !localVideoRef.current) {
      return
    }

    const video = localVideoRef.current
    video.srcObject = localStreamRef.current
    video.muted = true
    video.playsInline = true

    video.play().catch((error) => {
      console.error('Local video playback failed:', error)
      setCameraError('Camera started, but video playback failed.')
    })
  }, [joined])

  useEffect(() => {
    return () => {
      localStreamRef.current?.getTracks().forEach((track) => track.stop())
      peerConnectionRef.current?.close()
      socketRef.current?.disconnect()
    }
  }, [])

  const startCamera = async () => {
    if (localStreamRef.current) return localStreamRef.current

    setCameraError('')

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Camera access is unavailable. Use localhost or HTTPS.')
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: 'user',
        },
        audio: true,
      })

      localStreamRef.current = stream
      setCameraOn(true)
      setMicOn(true)

      return stream
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown camera error'

      setCameraError(message)
      throw error
    }
  }

  const createPeerConnection = (room: string) => {
    const peer = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    })

    peerConnectionRef.current = peer

    localStreamRef.current?.getTracks().forEach((track) => {
      peer.addTrack(track, localStreamRef.current!)
    })

    peer.ontrack = (event) => {
      const [remoteStream] = event.streams

      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = remoteStream
        remoteVideoRef.current.play().catch(console.error)
      }

      setStatus('Connected')
    }

    peer.onicecandidate = (event) => {
      if (event.candidate) {
        socketRef.current?.emit('ice-candidate', {
          roomId: room,
          candidate: event.candidate,
        })
      }
    }

    peer.onconnectionstatechange = () => {
      const state = peer.connectionState

      console.log('WebRTC connection state:', state)

      if (state === 'connected') setStatus('Connected')
      if (state === 'connecting') setStatus('Connecting...')

      if (['disconnected', 'failed', 'closed'].includes(state)) {
        setStatus('Connection lost')
      }
    }

    return peer
  }

  const configureSocket = (socket: Socket, room: string) => {
    socket.on('peer-ready', async () => {
      try {
        setStatus('Calling participant...')

        const peer = createPeerConnection(room)
        const offer = await peer.createOffer()

        await peer.setLocalDescription(offer)

        socket.emit('offer', { roomId: room, offer })
      } catch (error) {
        console.error('Could not create offer:', error)
        setStatus('Could not start call')
      }
    })

    socket.on('offer', async (offer) => {
      try {
        setStatus('Accepting connection...')

        const peer = createPeerConnection(room)

        await peer.setRemoteDescription(new RTCSessionDescription(offer))

        const answer = await peer.createAnswer()

        await peer.setLocalDescription(answer)

        socket.emit('answer', { roomId: room, answer })
      } catch (error) {
        console.error('Could not accept offer:', error)
        setStatus('Could not accept call')
      }
    })

    socket.on('answer', async (answer) => {
      try {
        const peer = peerConnectionRef.current
        if (!peer) return

        await peer.setRemoteDescription(new RTCSessionDescription(answer))
      } catch (error) {
        console.error('Could not set answer:', error)
      }
    })

    socket.on('ice-candidate', async (candidate) => {
      try {
        const peer = peerConnectionRef.current
        if (!peer) return

        await peer.addIceCandidate(new RTCIceCandidate(candidate))
      } catch (error) {
        console.error('Could not add ICE candidate:', error)
      }
    })

    socket.on('peer-left', () => {
      setStatus('The other person left the call')

      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = null
      }

      peerConnectionRef.current?.close()
      peerConnectionRef.current = null
    })

    socket.on('room-closed', () => {
      setStatus('The host closed this room')
      leaveCall()
    })

    socket.on('room-full', () => {
      setRoomError('This room already has two participants.')
      setStatus('Room is full')
    })

    socket.on('room-error', (message: string) => {
      setRoomError(message)
      setStatus('Could not enter room')
    })
  }

  // OWNER LOGIN
  const loginOwner = () => {
    setRoomError('')

    if (!ownerPassword) {
      setRoomError('Enter your owner password.')
      return
    }

    if (socketRef.current) {
      socketRef.current.disconnect()
      socketRef.current = null
    }

    const socket = io(SIGNALING_SERVER)
    socketRef.current = socket

    socket.on('connect', () => {
      socket.emit('owner-login', {
        password: ownerPassword,
      })
    })

    socket.on('owner-authenticated', () => {
      setOwnerAuthenticated(true)
      setOwnerPassword('')
      setRoomError('')
      setRoomMode('create')
      setStatus('Owner authenticated')
    })

    socket.on('owner-login-error', (message: string) => {
      setRoomError(message)
      setStatus('Login failed')
      socket.disconnect()
      socketRef.current = null
    })

    socket.on('connect_error', (error) => {
      console.error('Owner login connection failed:', error)
      setRoomError('Could not connect to the server. Is it running?')
    })
  }

  // OWNER-ONLY ROOM CREATION
  const createRoom = async () => {
    setRoomError('')

    if (!ownerAuthenticated) {
      setRoomError('Please log in as the owner first.')
      setRoomMode('owner-login')
      return
    }

    if (createPasscode.length < 4 || createPasscode.length > 64) {
      setRoomError('Choose a passcode between 4 and 64 characters.')
      return
    }

    const socket = socketRef.current

    if (!socket?.connected) {
      setRoomError('Your owner session has disconnected. Please log in again.')
      setOwnerAuthenticated(false)
      setRoomMode('owner-login')
      return
    }

    try {
      await startCamera()

      socket.once('room-created', ({ roomId: newRoomId, roomName: newRoomName }) => {
        setRoomId(newRoomId)
        setRoomName(newRoomName)

        const link = `${window.location.origin}/?room=${newRoomId}`
        setInviteUrl(link)

        window.history.replaceState({}, '', `/?room=${newRoomId}`)

        configureSocket(socket, newRoomId)

        setJoined(true)
        setStatus('Room created. Waiting for your guest...')
      })

      socket.emit('create-room', {
        roomName,
        passcode: createPasscode,
      })

      setCreatePasscode('')
    } catch (error) {
      console.error('Could not create room:', error)
    }
  }

  // GUEST ROOM JOINING
  const joinRoom = async () => {
    setRoomError('')

    if (!roomId.trim() || !joinPasscode) {
      setRoomError('Enter your room ID and passcode.')
      return
    }

    try {
      await startCamera()

      const cleanRoomId = roomId.trim().toUpperCase()

      const socket = io(SIGNALING_SERVER)
      socketRef.current = socket

      configureSocket(socket, cleanRoomId)

      socket.on('connect', () => {
        socket.emit('join-room', {
          roomId: cleanRoomId,
          passcode: joinPasscode,
        })
      })

      socket.on('joined-room', ({ roomId: joinedRoomId, roomName: name }) => {
        setRoomId(joinedRoomId)
        setRoomName(name)
        setJoined(true)
        setStatus('Joined successfully. Connecting...')
      })
    } catch (error) {
      console.error('Could not join room:', error)
    }
  }

  const copyInvitation = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl)
      setStatus('Invitation link copied!')
    } catch {
      setRoomError('Could not copy the link. You can copy it manually.')
    }
  }

  const shareInvitation = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'PrivateCall invitation',
          text: `Join my private room: ${roomName}`,
          url: inviteUrl,
        })
      } catch (error) {
        if (error instanceof Error && error.name !== 'AbortError') {
          console.error('Sharing failed:', error)
        }
      }
    } else {
      await copyInvitation()
    }
  }

  const toggleCamera = () => {
    const track = localStreamRef.current?.getVideoTracks()[0]
    if (!track) return

    track.enabled = !track.enabled
    setCameraOn(track.enabled)
  }

  const toggleMic = () => {
    const track = localStreamRef.current?.getAudioTracks()[0]
    if (!track) return

    track.enabled = !track.enabled
    setMicOn(track.enabled)
  }

  function leaveCall() {
    socketRef.current?.emit('leave-room')
    peerConnectionRef.current?.close()

    localStreamRef.current?.getTracks().forEach((track) => track.stop())

    if (localVideoRef.current) localVideoRef.current.srcObject = null
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null

    socketRef.current?.disconnect()

    socketRef.current = null
    peerConnectionRef.current = null
    localStreamRef.current = null

    setJoined(false)
    setInviteUrl('')
    setCameraError('')
    setRoomError('')
    setOwnerAuthenticated(false)
    setStatus('Ready to connect')
    setRoomMode('home')

    window.history.replaceState({}, '', '/')
  }

  const logoutOwner = () => {
    socketRef.current?.disconnect()
    socketRef.current = null

    setOwnerAuthenticated(false)
    setOwnerPassword('')
    setRoomError('')
    setRoomMode('home')
    setStatus('Logged out')
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-icon">P</div>
          <span>PrivateCall</span>
        </div>

        <div className="status">
          <span className="status-dot"></span>
          {status}
        </div>
      </header>

      {!joined ? (
        <main className="join-screen">
          <div className="join-card">
            <div className="large-icon">P</div>

            <h1>PrivateCall</h1>
            <p>Private conversations. Your room, your rules.</p>

            {roomMode === 'home' && (
              <>
                <button
                  className="join-button"
                  onClick={() => {
                    setRoomError('')
                    setRoomMode('owner-login')
                  }}
                >
                  Owner login
                </button>

                <button
                  className="join-button"
                  onClick={() => {
                    setRoomError('')
                    setRoomMode('join')
                  }}
                >
                  Join a room
                </button>
              </>
            )}

            {roomMode === 'owner-login' && (
              <>
                <h2>Owner login</h2>

                <p>Enter your private owner password to continue.</p>

                <input
                  type="password"
                  value={ownerPassword}
                  onChange={(event) => setOwnerPassword(event.target.value)}
                  placeholder="Your owner password"
                  autoComplete="current-password"
                />

                <button className="join-button" onClick={loginOwner}>
                  Log in securely
                </button>

                <button
                  className="control"
                  onClick={() => {
                    setRoomError('')
                    setRoomMode('home')
                  }}
                >
                  Back
                </button>
              </>
            )}

            {roomMode === 'create' && ownerAuthenticated && (
              <>
                <h2>Create your private room</h2>

                <p>Owner access verified.</p>

                <input
                  value={roomName}
                  onChange={(event) => setRoomName(event.target.value)}
                  placeholder="Room name"
                />

                <input
                  type="password"
                  value={createPasscode}
                  onChange={(event) => setCreatePasscode(event.target.value)}
                  placeholder="Choose a room passcode (minimum 4 characters)"
                />

                <button className="join-button" onClick={createRoom}>
                  Create room
                </button>

                <button
                  className="control"
                  onClick={logoutOwner}
                >
                  Log out
                </button>
              </>
            )}

            {roomMode === 'join' && (
              <>
                <h2>Join a private room</h2>

                <input
                  value={roomId}
                  onChange={(event) => setRoomId(event.target.value)}
                  placeholder="Room ID"
                />

                <input
                  type="password"
                  value={joinPasscode}
                  onChange={(event) => setJoinPasscode(event.target.value)}
                  placeholder="Enter room passcode"
                />

                <button className="join-button" onClick={joinRoom}>
                  Join securely
                </button>

                <button
                  className="control"
                  onClick={() => {
                    setRoomError('')
                    setRoomMode('home')
                  }}
                >
                  Back
                </button>
              </>
            )}

            {roomError && (
              <div className="security-info camera-error">
                {roomError}
              </div>
            )}

            {cameraError && (
              <div className="security-info camera-error">
                Camera error: {cameraError}
              </div>
            )}

            <div className="security-info">
              🔒 Private rooms are protected by passcodes.
            </div>
          </div>
        </main>
      ) : (
        <main className="call-area">
          <div className="video-grid">
            <div className="video-card">
              <video
                ref={localVideoRef}
                autoPlay
                muted
                playsInline
                className="camera-video"
              />
              <div className="video-label">You</div>
            </div>

            <div className="video-card">
              <video
                ref={remoteVideoRef}
                autoPlay
                playsInline
                className="camera-video remote"
              />
              <div className="video-label">Guest</div>
            </div>
          </div>

          <div className="privacy-notice">
            🔒 {roomName} · Room {roomId}
          </div>

          {inviteUrl && (
            <div className="security-info">
              <p>Share this invitation with your guest:</p>
              <p>{inviteUrl}</p>

              <button className="join-button" onClick={copyInvitation}>
                Copy invitation link
              </button>

              <button className="join-button" onClick={shareInvitation}>
                Share invitation
              </button>
            </div>
          )}
        </main>
      )}

      {joined && (
        <footer className="controls">
          <button
            className={`control ${!micOn ? 'off' : ''}`}
            onClick={toggleMic}
          >
            {micOn ? '🎤' : '🔇'}
            <span>{micOn ? 'Mute' : 'Unmute'}</span>
          </button>

          <button
            className={`control ${!cameraOn ? 'off' : ''}`}
            onClick={toggleCamera}
          >
            {cameraOn ? '📹' : '🚫'}
            <span>{cameraOn ? 'Camera' : 'Camera off'}</span>
          </button>

          <button className="end-call" onClick={leaveCall}>
            📞
            <span>End call</span>
          </button>
        </footer>
      )}
    </div>
  )
}

export default App
