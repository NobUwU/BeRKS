import {
    Packets,
    packet_disconnect,
    packet_player_list,
    packet_start_game,
    PlayerRecordsRecord,
} from "../../types/packets.i"
import { RakManager } from "../raknet"
import { Logger } from '../../console'
import { ConnectionManager } from "./ConnectionManager"
import {
    ActivePlugin,
    RealmAPIWorld,
} from "src/types/berp"
import { BeRP } from ".."

// TODO: Client/plugins can control connection/diconnection of rak 
// Coming [Soon™]


export class ConnectionHandler extends RakManager {

    public static readonly KEEPALIVEINT = 10
    public readonly host: string
    public readonly port: number
    public readonly realm: RealmAPIWorld
    public playerQue: PlayerRecordsRecord[] = []
    private _gameInfo: packet_start_game
    private _tickSync = 0n
    private _tickSyncKeepAlive: NodeJS.Timer
    private _connectionManager: ConnectionManager
    private _log: Logger
    private _plugins = new Map<string, ActivePlugin>()
    private _berp: BeRP
    private _compressor: "deflate" | "snappy" | "none"
    constructor(host: string, port: number, realm: RealmAPIWorld, cm: ConnectionManager, berp: BeRP) {
        super(host, port, cm.getAccount().username, realm.id)
        this.host = host
        this.port = port
        this.realm = realm
        this._compressor = "deflate"
        this._connectionManager = cm
        this._berp = berp

        this._log = new Logger(`Connection Handler (${cm.getAccount().username}:${realm.id})`, 'cyanBright')

        this.setMaxListeners(Infinity)

        this.once('rak_connected', this._handleLogin.bind(this))
        this.once(Packets.NetworkSettings, this._handleNetworkSettings.bind(this))
        this.once(Packets.ServerToClientHandshake, this._handleHandshake.bind(this))
        this.once(Packets.ResourcePacksInfo, async () => {
            await this._handleAcceptPacks()
            await this._cachedChunks()
        })
        this.once(Packets.ResourcePacksStack, this._handleAcceptPacks.bind(this))
        this.once(Packets.StartGame, this._handleGameStart.bind(this))
        this.on(Packets.PlayerList, this._playerQue.bind(this))
        this.once(Packets.Disconnect, this._handleDisconnect.bind(this))
        this.once('rak_closed', this._handleDisconnect.bind(this))

        this.on(Packets.TickSync, (pak) => {
            this._tickSync = pak.response_time
        })
        this._log.success("Initialized")
        // The start_game packet isn't being detected by BeRP anymore, very strange...
        //    Not with that attitude it isn't!
        setTimeout(async () => {
            this._registerPlugins()

            this.emit("rak_ready")
            this.removeListener('player_list', this._playerQue)
            await this.sendPacket(Packets.TickSync, {
                request_time: BigInt(Date.now()),
                response_time: 0n,
            })
            this._tickSyncKeepAlive = setInterval(async () => {
                await this.sendPacket(Packets.TickSync, {
                    request_time: this._tickSync,
                    response_time: 0n,
                })
            }, 50 * ConnectionHandler.KEEPALIVEINT)


            this.on(Packets.StartGame, async (pkt) => {
                try {
                    this._log.success("Got packet_start_game! Show this log to a developer!")
                    return
                } catch (error) {
                    this._log.error(error)
                    return
                }
            })
        }, 5000)
    }

    public getGameInfo(): packet_start_game { return this._gameInfo }
    public getLogger(): Logger { return this._log }
    public getTick(): bigint { return this._tickSync }
    public getConnectionManager(): ConnectionManager { return this._connectionManager }

    public close(): void {
        super.close()
        this.removeAllListeners()
        this._connectionManager.getConnections().delete(this.realm.id)
    }

    public sendCommandFeedback(option: boolean): void {
        this.sendPacket('command_request', {
            command: `gamerule sendcommandfeedback ${option}`,
            interval: false,
            origin: {
                uuid: '',
                request_id: '',
                type: 'player',
            },
        })
    }

    private _playerQue(pak?: packet_player_list) {
        for (const record of pak.records.records) {
            if (record.username == this.getXboxProfile().extraData.displayName) continue
            this.playerQue.push(record)
        }


 
  
    }

    private async _handleDisconnect(pak?: packet_disconnect): Promise<void> {
        let reason = "Rakky wacky committed a serious fuckywucky and had to get in the forever box D:"
        this._log.warn(reason)
        if (pak) {
            this._log.warn("Disconnect: Got a packet", pak?.message)
            try{this._log.warn(JSON.stringify(pak))}catch(e){console.log(e)}
            reason = pak.message
        }
        await this._berp.getPluginManager().killPlugins(this)
        clearInterval(this._tickSyncKeepAlive)
        this._log.warn(`Terminating connection handler with connection "${this.host}:${this.port}"`)
        this.close()
        this._log.warn("Disconnection on", `${this.host}:${this.port}`, `"${reason}"`)
        this._log.warn("Ending process to trigger restart...")
        process.exit()
    }
    private async _handleLogin(): Promise<void> {
        await this.sendPacket(Packets.Login, this.createLoginPayload())
    }
    private async _handleHandshake(): Promise<void> {
        setTimeout(async () => {
            await this.sendPacket(Packets.ClientToServerHandshake, {})
        }, 0)
    }
    private async _handleAcceptPacks(): Promise<void> {
        await this.sendPacket(Packets.ResourcePackClientResponse, {
            response_status: 'completed',
            resourcepackids: [],
        })
    }
    private async _handleNetworkSettings(): Promise<void> {
	await this.sendPacket(Packets.RequestNetworkSettings, {client_protocol: 554})
    }
    private async _cachedChunks(): Promise<void> {
        await this.sendPacket(Packets.ClientCacheStatus, {
            enabled: false,
        })
        await this.sendPacket(Packets.RequestChunkRadius, {
            chunk_radius: 1,
        })
    }
    private async _handleGameStart(pak: packet_start_game): Promise<void> {

        this._log.success('Got start game packet!')
        this._gameInfo = pak
        await this.sendPacket(Packets.SetLocalPlayerAsInitialized, {
            runtime_entity_id: pak.runtime_entity_id,
        })
        this.emit("rak_ready")
        this._registerPlugins()
        this.removeListener('player_list', this._playerQue)
        await this.sendPacket(Packets.TickSync, {
            request_time: BigInt(Date.now()),
            response_time: 0n,
        })
        this._tickSyncKeepAlive = setInterval(async () => {
            await this.sendPacket(Packets.TickSync, {
                request_time: this._tickSync,
                response_time: 0n,
            })
        }, 50 * ConnectionHandler.KEEPALIVEINT)
    }
    private async _registerPlugins(): Promise<void> {
        const plugins = await this._berp.getPluginManager().registerPlugins(this)
        for (const plugin of plugins) {
            this._plugins.set(plugin.config.name, plugin)
        }
    }
    public getPlugins(): Map<string, ActivePlugin> { return this._plugins }
}
