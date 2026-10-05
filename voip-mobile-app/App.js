import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, Pressable, SafeAreaView, StyleSheet, Text, TextInput, View } from 'react-native';
import InCallManager from 'react-native-incall-manager';
import { io } from 'socket.io-client';
import {
  mediaDevices,
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
} from 'react-native-webrtc';

const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

export default function App() {
  const [serverUrl, setServerUrl] = useState(process.env.EXPO_PUBLIC_CALL_SERVER_URL || 'https://voip-ringio-prototype.vercel.app');
  const [connection, setConnection] = useState('disconnected');
  const [phoneRegistered, setPhoneRegistered] = useState(false);
  const [callState, setCallState] = useState('idle');
  const [incomingCall, setIncomingCall] = useState(null);
  const [dialedNumber, setDialedNumber] = useState(null);
  const [speakerphoneEnabled, setSpeakerphoneEnabled] = useState(false);
  const [message, setMessage] = useState('Connect to the call server to register this phone.');
  const socketRef = useRef(null);
  const incomingPollRef = useRef(null);
  const signalPollRef = useRef(null);
  const audioStatsPollRef = useRef(null);
  const signalOffsetRef = useRef(0);
  const seenSignalIdsRef = useRef(new Set());
  const peerRef = useRef(null);
  const localStreamRef = useRef(null);
  const callIdRef = useRef(null);
  const candidatesRef = useRef([]);
  const audioModeActiveRef = useRef(false);
  const speakerphoneEnabledRef = useRef(false);

  const closePeer = () => {
    if (audioStatsPollRef.current) clearInterval(audioStatsPollRef.current);
    audioStatsPollRef.current = null;
    if (peerRef.current) peerRef.current.close();
    peerRef.current = null;
    if (localStreamRef.current) localStreamRef.current.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    if (audioModeActiveRef.current) {
      InCallManager.stop();
      audioModeActiveRef.current = false;
    }
    candidatesRef.current = [];
  };

  const finishCall = (nextMessage = 'Ready for the next call.') => {
    if (signalPollRef.current) clearInterval(signalPollRef.current);
    signalPollRef.current = null;
    closePeer();
    callIdRef.current = null;
    setIncomingCall(null);
    setDialedNumber(null);
    speakerphoneEnabledRef.current = false;
    setSpeakerphoneEnabled(false);
    setCallState('idle');
    setMessage(nextMessage);
  };

  const addQueuedCandidates = async (peer) => {
    const queued = candidatesRef.current;
    candidatesRef.current = [];
    for (const candidate of queued) await peer.addIceCandidate(candidate);
  };

  const showIncomingCall = ({ callId, caller, number }) => {
    if (!callId || callIdRef.current === callId) return;
    callIdRef.current = callId;
    setIncomingCall({ callId, caller, number });
    setDialedNumber(number);
    setCallState('ringing');
    setMessage(`Incoming simulated call to ${number}`);
  };

  const getRtcConfig = async () => {
    const normalizedUrl = serverUrl.trim().replace(/\/$/, '');
    try {
      const response = await fetch(`${normalizedUrl}/api/ice-config`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const config = await response.json();
      if (!Array.isArray(config.iceServers) || config.iceServers.length === 0) {
        throw new Error('The server returned no ICE servers.');
      }
      return { iceServers: config.iceServers };
    } catch (error) {
      setMessage(`TURN configuration unavailable; trying STUN only: ${error.message}`);
      return RTC_CONFIG;
    }
  };

  const startAudioStats = (peer, callId) => {
    if (audioStatsPollRef.current) clearInterval(audioStatsPollRef.current);
    if (typeof peer.getStats !== 'function') {
      console.warn('[audio-stats] RTCPeerConnection.getStats is unavailable.');
      return;
    }

    let previousInbound;
    let polling = false;
    const poll = async () => {
      if (polling || peerRef.current !== peer || callIdRef.current !== callId) return;
      polling = true;
      try {
        const report = await peer.getStats();
        const entries = [];
        if (typeof report?.forEach === 'function') report.forEach((stat) => entries.push(stat));
        else if (Array.isArray(report)) entries.push(...report);
        else if (report && typeof report === 'object') entries.push(...Object.values(report));

        const inbound = entries.find((stat) => stat.type === 'inbound-rtp'
          && (stat.kind === 'audio' || stat.mediaType === 'audio'));
        const transport = entries.find((stat) => stat.type === 'transport' && stat.selectedCandidatePairId);
        const pair = entries.find((stat) => stat.id === transport?.selectedCandidatePairId)
          || entries.find((stat) => stat.type === 'candidate-pair'
            && stat.state === 'succeeded' && (stat.selected || stat.nominated));
        const localCandidate = entries.find((stat) => stat.id === pair?.localCandidateId);
        const remoteCandidate = entries.find((stat) => stat.id === pair?.remoteCandidateId);
        const counterDelta = (key) => {
          if (!Number.isFinite(inbound?.[key])) return null;
          if (!Number.isFinite(previousInbound?.[key])) return inbound[key];
          return Math.max(0, inbound[key] - previousInbound[key]);
        };
        const lostDelta = counterDelta('packetsLost');
        const receivedDelta = counterDelta('packetsReceived');
        const concealedDelta = counterDelta('concealedSamples');
        const emittedDelta = counterDelta('jitterBufferEmittedCount');
        const jitterDelayDelta = counterDelta('jitterBufferDelay');
        const jitterBufferMs = emittedDelta > 0 && jitterDelayDelta !== null
          ? Math.round(jitterDelayDelta / emittedDelta * 1000)
          : null;

        console.info('[audio-stats]', JSON.stringify({
          callId,
          inboundAudio: inbound ? {
            jitterMs: Number.isFinite(inbound.jitter) ? Math.round(inbound.jitter * 1000) : null,
            packetsLostDelta: lostDelta,
            packetsReceivedDelta: receivedDelta,
            concealedSamplesDelta: concealedDelta,
            jitterBufferMs,
          } : null,
          selectedPath: pair ? {
            localType: localCandidate?.candidateType || null,
            remoteType: remoteCandidate?.candidateType || null,
            rttMs: Number.isFinite(pair.currentRoundTripTime)
              ? Math.round(pair.currentRoundTripTime * 1000)
              : null,
          } : null,
        }));
        previousInbound = inbound ? { ...inbound } : previousInbound;
      } catch (error) {
        console.warn('[audio-stats] Could not read WebRTC stats:', error.message);
      } finally {
        polling = false;
      }
    };

    poll();
    audioStatsPollRef.current = setInterval(poll, 3000);
  };

  const handleRtcOffer = async ({ callId, description }) => {
    if (callIdRef.current !== callId) return;
    let peer;
    try {
      setMessage('Requesting microphone access…');
      const stream = await mediaDevices.getUserMedia({ audio: true, video: false });
      localStreamRef.current = stream;
      InCallManager.start({ media: 'audio' });
      audioModeActiveRef.current = true;
      InCallManager.setForceSpeakerphoneOn(speakerphoneEnabledRef.current ? true : null);
      peer = new RTCPeerConnection(await getRtcConfig());
      peerRef.current = peer;
      stream.getTracks().forEach((track) => peer.addTrack(track, stream));
      peer.ontrack = () => {
        setMessage('Gemini audio connected · speak through your phone.');
      };
      peer.onicecandidate = ({ candidate }) => {
        if (candidate && callIdRef.current === callId) {
          socketRef.current?.emit('rtc:ice', { callId, candidate });
        }
      };
      peer.onconnectionstatechange = () => {
        if (peerRef.current !== peer) return;
        if (peer.connectionState === 'connected') {
          setCallState('active');
          setMessage('Connected · speak through your phone.');
          startAudioStats(peer, callId);
        } else if (peer.connectionState === 'failed' || peer.connectionState === 'closed') {
          finishCall('Audio connection lost.');
        }
      };
      await peer.setRemoteDescription(new RTCSessionDescription(description));
      await addQueuedCandidates(peer);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      socketRef.current?.emit('rtc:answer', { callId, description: peer.localDescription });
      setCallState('connecting');
      setMessage('Connecting audio…');
    } catch (error) {
      if (peer) peer.close();
      peerRef.current = null;
      socketRef.current?.emit('call:end', { callId });
      finishCall(`Could not start microphone or call audio: ${error.message}`);
    }
  };

  const handleRtcIce = async ({ callId, candidate }) => {
    if (!candidate || callIdRef.current !== callId) return;
    const peer = peerRef.current;
    if (peer?.remoteDescription) await peer.addIceCandidate(new RTCIceCandidate(candidate));
    else candidatesRef.current.push(new RTCIceCandidate(candidate));
  };

  const handleSignal = (eventName, payload) => {
    const signalId = payload.signalId;
    if (signalId && seenSignalIdsRef.current.has(signalId)) return;
    if (signalId) seenSignalIdsRef.current.add(signalId);
    if (eventName === 'rtc:offer') handleRtcOffer(payload);
    else if (eventName === 'rtc:ice') handleRtcIce(payload);
  };

  const startSignalPolling = (callId, baseUrl) => {
    if (signalPollRef.current) clearInterval(signalPollRef.current);
    signalOffsetRef.current = 0;
    seenSignalIdsRef.current.clear();
    const pollSignals = async () => {
      if (callIdRef.current !== callId) return;
      try {
        const response = await fetch(`${baseUrl}/api/calls/${callId}/signals/phone?offset=${signalOffsetRef.current}`);
        if (!response.ok) return;
        const result = await response.json();
        signalOffsetRef.current = result.nextOffset;
        result.events.forEach((signal) => handleSignal(signal.eventName, { ...signal.payload, signalId: signal.id }));
      } catch {
        // Socket.IO remains the primary path; polling recovers missed WebRTC events.
      }
    };
    pollSignals();
    signalPollRef.current = setInterval(pollSignals, 500);
  };

  const connect = () => {
    const normalizedUrl = serverUrl.trim().replace(/\/$/, '');
    if (!/^https?:\/\//i.test(normalizedUrl)) {
      setMessage('Enter a server address beginning with http:// or https://.');
      return;
    }
    if (socketRef.current) socketRef.current.disconnect();
    setPhoneRegistered(false);
    setConnection('connecting');
    setMessage('Connecting…');
    const socket = io(normalizedUrl, {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 10000,
    });
    socketRef.current = socket;
    socket.on('connect', () => {
      setConnection('connected');
      if (callIdRef.current) {
        socket.emit('call:reconnect', { callId: callIdRef.current, role: 'phone' });
        setMessage('Connected · speak through your phone.');
      } else {
        setPhoneRegistered(false);
        socket.emit('participant:register', { role: 'phone' });
      }
      if (incomingPollRef.current) clearInterval(incomingPollRef.current);
      incomingPollRef.current = null;
    });
    socket.on('call:reconnected', ({ callId }) => {
      if (callIdRef.current === callId) {
        setPhoneRegistered(true);
        setMessage('Connected · speak through your phone.');
      }
    });
    socket.on('participant:registered', ({ endpointId }) => {
      setPhoneRegistered(true);
      setMessage('Ready for the next call.');
      const pollCallState = async () => {
        try {
          if (callIdRef.current) {
            const response = await fetch(`${normalizedUrl}/api/calls/${callIdRef.current}`);
            if (!response.ok) return;
            const call = await response.json();
            if (['ended', 'failed', 'rejected'].includes(call.status)) {
              const disconnectedRole = call.disconnectedParticipantRole;
              finishCall(disconnectedRole ? `${disconnectedRole} connection lost.` : 'Call ended.');
            }
            return;
          }
          const response = await fetch(`${normalizedUrl}/api/endpoints/${encodeURIComponent(endpointId)}/incoming`);
          if (!response.ok) return;
          const { call } = await response.json();
          if (call) showIncomingCall(call);
        } catch {
          // Socket.IO remains the primary path; polling recovers missed cross-instance events.
        }
      };
      pollCallState();
      if (incomingPollRef.current) clearInterval(incomingPollRef.current);
      incomingPollRef.current = setInterval(pollCallState, 1500);
    });
    socket.on('connect_error', (error) => {
      setPhoneRegistered(false);
      setConnection('disconnected');
      setMessage(`Could not reach server: ${error.message}`);
    });
    socket.on('disconnect', () => {
      setPhoneRegistered(false);
      setConnection('disconnected');
      if (callIdRef.current) {
        setMessage('Signaling reconnecting… (call audio active)');
      } else {
        if (incomingPollRef.current) clearInterval(incomingPollRef.current);
        incomingPollRef.current = null;
        setMessage('Server connection lost. Reconnecting…');
      }
    });
    socket.on('call:incoming', showIncomingCall);
    socket.on('call:accepted', ({ callId }) => {
      if (callIdRef.current === callId) {
        setCallState('connecting');
        setMessage('Call accepted · waiting for PC audio…');
      }
    });
    socket.on('call:ended', ({ reason, disconnectedParticipantRole }) => finishCall(
      disconnectedParticipantRole
        ? `${disconnectedParticipantRole} disconnected.`
        : reason === 'participant-disconnected' ? 'The other participant disconnected.' : 'Call ended.',
    ));
    socket.on('rtc:offer', (payload) => handleSignal('rtc:offer', payload));
    socket.on('rtc:ice', (payload) => handleSignal('rtc:ice', payload));
    socket.on('call:error', ({ message: errorMessage }) => setMessage(errorMessage));
  };

  const acceptCall = () => {
    if (!incomingCall || !socketRef.current) return;
    const normalizedUrl = serverUrl.trim().replace(/\/$/, '');
    startSignalPolling(incomingCall.callId, normalizedUrl);
    socketRef.current.emit('call:accept', { callId: incomingCall.callId });
    setIncomingCall(null);
    setCallState('connecting');
    setMessage('Accepted · connecting audio…');
  };

  const endCall = () => {
    const activeCallId = callIdRef.current;
    if (activeCallId) {
      if (socketRef.current?.connected) {
        socketRef.current.emit('call:end', { callId: activeCallId });
      }
      const normalizedUrl = serverUrl.trim().replace(/\/$/, '');
      fetch(`${normalizedUrl}/api/calls/${encodeURIComponent(activeCallId)}/end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }).catch(() => {});
    }
    finishCall();
  };

  const toggleSpeakerphone = () => {
    const enabled = !speakerphoneEnabledRef.current;
    speakerphoneEnabledRef.current = enabled;
    setSpeakerphoneEnabled(enabled);
    if (audioModeActiveRef.current) InCallManager.setForceSpeakerphoneOn(enabled ? true : null);
  };

  const connectOnMount = useEffectEvent(() => connect());

  useEffect(() => {
    const timer = setTimeout(connectOnMount, 0);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (callState !== 'ringing') {
      InCallManager.stopRingtone();
      return undefined;
    }

    InCallManager.startRingtone('_DEFAULT_', [0, 1000, 500, 1000]);
    return () => InCallManager.stopRingtone();
  }, [callState]);

  useEffect(() => () => {
    closePeer();
    if (incomingPollRef.current) clearInterval(incomingPollRef.current);
    if (socketRef.current) socketRef.current.disconnect();
  }, []);

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <View style={styles.container}>
        <View style={styles.header}>
          <View style={styles.brandMark}><Text style={styles.brandLetter}>R</Text></View>
          <View style={styles.headerCopy}>
            <Text style={styles.kicker}>RINGIO VOICE</Text>
            <Text style={styles.heading}>Mobile line</Text>
          </View>
          <View style={[styles.indicator, connection === 'connected' && styles.indicatorOnline]} />
        </View>

        <View style={styles.numberBand}>
          <Text style={styles.numberLabel}>SIMULATED DESTINATION</Text>
          <Text style={styles.number}>{dialedNumber || 'Ready'}</Text>
          <Text style={styles.simNote}>No SIM · the server routes calls to this app</Text>
        </View>

        <View style={styles.statusRow}>
          {connection === 'connecting' ? <ActivityIndicator color="#a9efc3" size="small" /> : <View style={[styles.statusDot, connection === 'connected' && styles.statusDotOnline]} />}
          <Text style={styles.statusText}>{connection === 'connected' ? 'SERVER CONNECTED' : connection === 'connecting' ? 'CONNECTING' : 'OFFLINE'}</Text>
          <Text style={styles.callLabel}>{phoneRegistered && callState === 'idle' ? 'READY' : connection === 'connected' && !phoneRegistered ? 'REGISTERING' : callState.toUpperCase()}</Text>
        </View>

        <Text style={styles.message}>{message}</Text>

        {incomingCall ? (
          <View style={styles.callActions}>
            <Pressable
              accessibilityRole="switch"
              accessibilityState={{ checked: speakerphoneEnabled }}
              onPress={toggleSpeakerphone}
              style={[styles.actionButton, styles.speakerButton, speakerphoneEnabled && styles.speakerButtonActive]}
            >
              <Text style={[styles.speakerText, speakerphoneEnabled && styles.speakerTextActive]}>
                Speaker {speakerphoneEnabled ? 'On' : 'Off'}
              </Text>
            </Pressable>
            <Pressable style={[styles.actionButton, styles.acceptButton]} onPress={acceptCall}>
              <Text style={styles.acceptText}>Answer call</Text>
            </Pressable>
            <Pressable style={[styles.actionButton, styles.declineButton]} onPress={() => {
              socketRef.current?.emit('call:reject', { callId: incomingCall.callId });
              finishCall('Call declined.');
            }}>
              <Text style={styles.declineText}>Decline</Text>
            </Pressable>
          </View>
        ) : callState !== 'idle' ? (
          <View style={styles.callActions}>
            <Pressable
              accessibilityRole="switch"
              accessibilityState={{ checked: speakerphoneEnabled }}
              onPress={toggleSpeakerphone}
              style={[styles.actionButton, styles.speakerButton, speakerphoneEnabled && styles.speakerButtonActive]}
            >
              <Text style={[styles.speakerText, speakerphoneEnabled && styles.speakerTextActive]}>
                Speaker {speakerphoneEnabled ? 'On' : 'Off'}
              </Text>
            </Pressable>
            <Pressable style={[styles.actionButton, styles.declineButton]} onPress={endCall}>
              <Text style={styles.declineText}>End call</Text>
            </Pressable>
          </View>
        ) : null}

        <View style={styles.connectionForm}>
          <Text style={styles.fieldLabel}>CALL SERVER ADDRESS</Text>
          <TextInput
            accessibilityLabel="Call server address"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            onChangeText={setServerUrl}
            placeholder="http://192.168.1.20:4100"
            placeholderTextColor="#728078"
            style={styles.input}
            value={serverUrl}
          />
          <Pressable disabled={connection === 'connecting'} onPress={connect} style={[styles.connectButton, connection === 'connecting' && styles.disabledButton]}>
            <Text style={styles.connectText}>{connection === 'connected' ? 'Reconnect' : 'Connect to server'}</Text>
          </Pressable>
        </View>

        <Text style={styles.footer}>Keep this app open while testing. Background incoming-call support is a later native/push milestone.</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#101614' },
  container: { flex: 1, paddingHorizontal: 24, paddingTop: 28, backgroundColor: '#101614' },
  header: { flexDirection: 'row', alignItems: 'center', paddingBottom: 22, borderBottomWidth: 1, borderBottomColor: '#2a3730' },
  brandMark: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center', backgroundColor: '#d4f36a', borderRadius: 9 },
  brandLetter: { color: '#102017', fontSize: 18, fontWeight: '800' },
  headerCopy: { flex: 1, marginLeft: 12 },
  kicker: { color: '#a9efc3', fontSize: 10, letterSpacing: 1.4, fontWeight: '700' },
  heading: { color: '#e7eee9', fontSize: 18, fontWeight: '700', marginTop: 2 },
  indicator: { width: 9, height: 9, borderRadius: 6, backgroundColor: '#68756c' },
  indicatorOnline: { backgroundColor: '#a9efc3' },
  numberBand: { paddingVertical: 34, borderBottomWidth: 1, borderBottomColor: '#2a3730' },
  numberLabel: { color: '#8c9a91', fontSize: 10, letterSpacing: 1.2, fontWeight: '700' },
  number: { color: '#e7eee9', fontSize: 54, lineHeight: 66, fontWeight: '600', letterSpacing: 0 },
  simNote: { color: '#8c9a91', fontSize: 12, marginTop: 6 },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginTop: 24 },
  statusDot: { width: 8, height: 8, borderRadius: 5, marginRight: 9, backgroundColor: '#68756c' },
  statusDotOnline: { backgroundColor: '#a9efc3' },
  statusText: { color: '#a9efc3', fontSize: 10, letterSpacing: 1, fontWeight: '700' },
  callLabel: { marginLeft: 'auto', color: '#8c9a91', fontSize: 10, letterSpacing: .8 },
  message: { minHeight: 48, marginTop: 16, color: '#e7eee9', fontSize: 15, lineHeight: 22 },
  callActions: { flexDirection: 'row', gap: 10, marginTop: 16 },
  actionButton: { minHeight: 50, flex: 1, alignItems: 'center', justifyContent: 'center', borderRadius: 7 },
  acceptButton: { backgroundColor: '#a9efc3' },
  acceptText: { color: '#102017', fontSize: 14, fontWeight: '700' },
  speakerButton: { backgroundColor: '#17211b', borderWidth: 1, borderColor: '#44544a' },
  speakerButtonActive: { backgroundColor: '#d4f36a', borderColor: '#d4f36a' },
  speakerText: { color: '#e7eee9', fontSize: 14, fontWeight: '700' },
  speakerTextActive: { color: '#102017' },
  declineButton: { backgroundColor: '#2a3730', borderWidth: 1, borderColor: '#44544a' },
  declineText: { color: '#ffab9c', fontSize: 14, fontWeight: '700' },
  connectionForm: { marginTop: 'auto', paddingTop: 24 },
  fieldLabel: { marginBottom: 9, color: '#8c9a91', fontSize: 10, letterSpacing: 1, fontWeight: '700' },
  input: { height: 50, paddingHorizontal: 13, color: '#e7eee9', backgroundColor: '#17211b', borderWidth: 1, borderColor: '#2a3730', borderRadius: 7, fontSize: 14 },
  connectButton: { height: 50, alignItems: 'center', justifyContent: 'center', marginTop: 10, backgroundColor: '#d4f36a', borderRadius: 7 },
  disabledButton: { opacity: .6 },
  connectText: { color: '#102017', fontSize: 14, fontWeight: '700' },
  footer: { marginTop: 16, paddingBottom: 16, color: '#728078', fontSize: 11, lineHeight: 16 },
});
