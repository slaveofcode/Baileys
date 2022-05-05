import Redis from 'ioredis'
import makeSocket, { AuthenticationCreds, AuthenticationState, Browsers, BufferJSON, DisconnectReason, initAuthCreds, proto, SignalDataTypeMap } from '../src'

const redis = new Redis({
	port: 6379,
	host: '127.0.0.1'
})

const KEY_MAP: { [T in keyof SignalDataTypeMap]: string } = {
	'pre-key': 'preKeys',
	'session': 'sessions',
	'sender-key': 'senderKeys',
	'app-state-sync-key': 'appStateSyncKeys',
	'app-state-sync-version': 'appStateVersions',
	'sender-key-memory': 'senderKeyMemory'
}

const useRedisAuthState = async(keyName: string): Promise<{ state: AuthenticationState, saveState: () => Promise<void>, clearState: () => Promise<void> }> => {
	let creds: AuthenticationCreds
	let keys: any = {}

	// fetch from redis first
	const storedCreds = await redis.get(keyName)
	if(storedCreds) {
		// if exist, we'll fill the creds and keys
		const parsedCreds = JSON.parse(storedCreds, BufferJSON.reviver)
		creds = parsedCreds.creds
		keys = parsedCreds.keys
	} else {
		// if not exist, initialize
		creds = initAuthCreds()
	}

	const saveState = async() => {
		// save creds & keys to redis
		await redis.set(keyName, JSON.stringify({
			creds,
			keys,
		}, BufferJSON.replacer, 2))
	}

	const clearState = async() => {
		await redis.del(keyName)
	}

	return {
		state: {
			creds,
			keys: {
				get: (type, ids) => {
					const key = KEY_MAP[type]
					return ids.reduce(
						(dict: any, id) => {
							let value = keys[key]?.[id]
							if(value) {
								if(type === 'app-state-sync-key') {
									value = proto.AppStateSyncKeyData.fromObject(value)
								}

								dict[id] = value
							}

							return dict
						}, { }
					)
				},
				set: (data: any) => {
					for(const _key in data) {
						const key = KEY_MAP[_key as keyof SignalDataTypeMap]
						keys[key] = keys[key] || { }
						Object.assign(keys[key], data[_key])
					}

					saveState()
				}
			}
		},
		saveState,
		clearState,
	}
}


const startSock = async() => {
	const myRedisKey = 'myWAKey'
	const { state, saveState, clearState } = await useRedisAuthState(myRedisKey)
	const sock = makeSocket({
		auth: state,
		browser: Browsers.ubuntu('Chrome'),
		printQRInTerminal: true,
	})

	sock.ev.on('creds.update', saveState)

	sock.ev.on('connection.update', (update) => {
		const { connection, lastDisconnect } = update

		if(connection === 'close') {
			const shouldReconnect = (lastDisconnect as any).error?.output?.statusCode !== DisconnectReason.loggedOut
			console.log('connection closed due to ', (lastDisconnect as any).error, ', reconnecting ', shouldReconnect)
			if(shouldReconnect) {
				return startSock()
			}

			const isUnauthorized = (lastDisconnect as any).error?.output?.statusCode === DisconnectReason.loggedOut
			const isDeviceRemoved = (lastDisconnect as any).error?.data?.content?.find((item: any) => item.attrs?.type === 'device_removed') !== undefined
			// clear stored auth if logout / unauthorized
			if(isUnauthorized && isDeviceRemoved) {
				console.info('Clearing state redis')
				clearState()
			}
		} else if(connection === 'open') {
			console.info('Connection ready!')
		}
	})

	sock.ev.on('messages.upsert', async m => {
		console.log(`------ messages.upsert ------
    ${JSON.stringify(m, undefined, 2)}
    ------ messages.upsert ------`)
	})
}

startSock()