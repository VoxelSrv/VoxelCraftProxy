import { EventEmitter } from 'events';
import * as fs from 'fs';

import * as configs from './lib/configs';

import startHeartbeat from './lib/heartbeat';

import { serverVersion, serverProtocol, serverConfig, setConfig, serverDefaultConfig } from './values';
import { BaseSocket } from './socket';
import * as console from './lib/console';
import {
	IActionClick,
	IActionInventoryClick,
	IActionBlockBreak,
	IActionBlockPlace,
	IActionClickEntity,
	IActionMessage,
	IActionMove,
	ILoginResponse,
	IActionLook,
	IActionMoveLook,
} from 'voxelsrv-protocol/js/client';

import ndarray = require('ndarray');
import { IPlayerTeleport, IWorldChunkLoad } from 'voxelsrv-protocol/js/server';

const minecraft = require('minecraft-protocol');
import { Vec3 } from 'vec3';
import * as vec from 'gl-vec3';
import { ConsoleLogger } from 'typedoc/dist/lib/utils';

const Chunk = require('prismarine-chunk')('1.16');
const mcData = require('minecraft-data')('1.16.3');

const blockRegistry: { [index: string]: {
	rawid: number;
	id: string;
	texture: string[];
	options: any;
	hardness: number;
	miningtime: number;
	tool: string;
	type: number;
	unbreakable: boolean;
} } = {};
const itemRegistry: { [index: string]: any } = {};

mcData.blocksArray.forEach((block: any) => {
	blockRegistry[block.name] = {
		rawid: block.id,
		id: block.name,
		texture: ['block/' + block.name],
		options: { solid: block.boundingBox == 'empty' ? false : true },
		hardness: 1,
		miningtime: 0,
		tool: 'pickaxe',
		type: 0,
		unbreakable: block.diggable,
	};
});

delete blockRegistry['air'];

const movement = {
	airJumps: 0,
	airMoveMult: 0.5,
	crouch: false,
	crouchMoveMult: 0.8,
	jumpForce: 6,
	jumpImpulse: 8.5,
	jumpTime: 500,
	jumping: false,
	maxSpeed: 5.5,
	moveForce: 30,
	responsiveness: 15,
	running: false,
	runningFriction: 0,
	sprint: false,
	sprintMoveMult: 1.2,
	standingFriction: 4,
};

let server: Server;

export function getServerInstance(): Server {
	return server;
}

export function startServer(): Server {
	server = new Server();
	return server;
}

class Server extends EventEmitter {
	playerCount: number = 0;
	players: { [index: string]: BaseSocket } = {};
	constructor() {
		super();
		this.startServer();
	}

	private async startServer() {
		console.log(`^yStarting VoxelCraft Proxy version^: ${serverVersion} ^y[Protocol:^: ${serverProtocol}^y]`);
		['./config'].forEach((element) => {
			if (!fs.existsSync(element)) {
				try {
					fs.mkdirSync(element);
					console.log(`^BCreated missing directory: ^w${element}`);
				} catch (e) {
					console.log(`^rCan't create directory: ^w${element}! Reason: ${e}`);
					process.exit();
				}
			}
		});
		//import('./lib/console-exec');

		const config = { ...serverDefaultConfig, ...configs.load('', 'config') };
		setConfig(config);
		configs.save('', 'config', config);

		this.emit('config-update', config);

		if (serverConfig.public) startHeartbeat();

		console.log('^yServer started on port: ^:' + serverConfig.port);
	}

	async connectPlayer(socket: BaseSocket) {
		socket.send('LoginRequest', {
			name: serverConfig.name,
			motd: serverConfig.motd,
			protocol: serverProtocol,
			maxplayers: serverConfig.maxplayers,
			numberplayers: this.playerCount,
			software: `VoxelCraft`,
		});

		let loginTimeout = true;

		socket.on('LoginResponse', (data: ILoginResponse) => {
			loginTimeout = false;
			const chunkStorage = {};
			const entityStorage = {};
			const playerStorage = {};

			socket.send('LoginSuccess', {
				xPos: 0,
				yPos: 255,
				zPos: 0,
				inventory: JSON.stringify({
					items: {},
					selected: 0,
					size: 27,
				}),
				blocksDef: JSON.stringify(blockRegistry),
				itemsDef: JSON.stringify({}),
				armor: JSON.stringify({
					items: {},
					selected: 0,
					size: 0,
				}),
				allowCheats: false,
				allowCustomSkins: true,
				movement: JSON.stringify(movement),
			});

			const player = minecraft.createClient({
				host: serverConfig.connect.address,
				port: serverConfig.connect.port,
				username: serverConfig.username,
				password: serverConfig.password,
			});

			player.on('packet', (d, m) => {
				//console.obj(d, m);
			});

			player.on('error', (e) => {
				console.error(e);
			});

			player.on('login_plugin_request', (d) => {
				player.write('login_plugin_response', {
					messageId: d.messageId,
					success: false,
				});
			});

			socket.send('PlayerHealth', {
				value: 0,
			});

			socket.send('PlayerEntity', { uuid: '0' });

			socket.on('close', () => {
				player.end();
			});
			socket.on('ActionMessage', (data: IActionMessage) => {
				player.write('chat', { message: data.message });
			});

			socket.on('ActionBlockBreak', (data: IActionBlockBreak) => {});

			socket.on('ActionBlockPlace', (data: IActionBlockPlace) => {});

			let canceler = 0;
			socket.on('ActionMove', (data: IActionMove) => {
				player.write('position', {
					x: data.x,
					y: data.y,
					z: data.z,
					onGround: true,
				});
			});

			socket.on('ActionLook', (data: IActionLook) => {
				player.write('look', {
					pitch: data.pitch,
					yaw: data.rotation,
				});
			});

			socket.on('ActionClick', (data: IActionClick) => {
				player.write('arm_animation', { hand: 0 });
			});

			socket.on('ActionClickEntity', (data: IActionClickEntity) => {
				player.write('arm_animation', { hand: 0 });
				player.write('use_entity', {
					target: parseInt(data.uuid),
					mouse: data.type == 'left' ? 1 : 0,
					hand: 0,
					sneaking: false,
				});
			});

			socket.on('ActionMoveLook', (data: IActionMoveLook) => {
				player.write('position_look', {
					x: data.x,
					y: data.y,
					z: data.z,
					onGround: true,
					pitch: data.pitch,
					yaw: data.rotation,
				});
			});

			socket.on('ActionInventoryClick', (data: IActionInventoryClick) => {});

			player.on('chat', (packet) => {
				const j = JSON.parse(packet.message);
				const msg = [];
				if (j.text != '') msg.push({ text: j.text, color: j.color != undefined ? j.color : 'white' });

				if (j.extra != undefined) {
					j.extra.forEach((element) => {
						if (element.color == 'gray') element.color = '#eeeeee';
						else if (element.color != undefined) element.color.replace('_', '');
						else element.color = 'white';
						msg.push(element);
					});
					socket.send('ChatMessage', { message: msg });
				}
			});

			player.on('position', async (packet) => {
				const data: IPlayerTeleport = {
					x: packet.x,
					y: packet.y,
					z: packet.z,
				};

				player.write('teleport_confirm', { teleportId: packet.teleportId });
				socket.send('PlayerTeleport', data);
			});

			player.on('disconnect', () => {
				console.log('disconnected');
				socket.close();
			});

			player.on('kick_disconnect', () => {
				console.log('kicked');
				socket.close();
			});

			player.on('player_info', (packet) => {
				if (packet.action == 0) {
					packet.data.forEach((p) => {
						playerStorage[p.UUID] = {
							name: p.name,
							displayName: p.displayName,
						};
					});
				} else if (packet.action == 4) {
					packet.data.forEach((p) => {
						delete playerStorage[p.UUID];
					});
				}
			});

			player.on('named_entity_spawn', (packet) => {
				socket.send('EntityCreate', {
					uuid: packet.entityId.toString(),
					data: JSON.stringify({
						position: [packet.x, packet.y, packet.z],
						rotation: 0,
						pitch: 0,
						health: 20,
						maxHealth: 20,
						model: 'player',
						texture: 'https://minotar.net/skin/' + packet.playerUUID,
						name: playerStorage[packet.playerUUID].name,
						nametag: true,
						hitbox: [0.6, 1.85, 0.6],
						armor: { items: {}, size: 0, selected: 0 },
					}),
				});

				entityStorage[packet.entityId] = {
					uuid: packet.entityId.toString(),
					pos: [packet.x, packet.y, packet.z],
				};
			});

			player.on('spawn_entity_living', (packet) => {
				if (packet.type != 1)
					socket.send('EntityCreate', {
						uuid: packet.entityId.toString(),
						data: JSON.stringify({
							position: [packet.x, packet.y, packet.z],
							rotation: 0,
							pitch: 0,
							health: 20,
							maxHealth: 20,
							model: 'player',
							texture: 'entity/alex',
							name: 'Undefined',
							nametag: false,
							hitbox: [0.6, 1.85, 0.6],
							armor: { items: {}, size: 0, selected: 0 },
						}),
					});

				entityStorage[packet.entityId] = {
					uuid: packet.entityId.toString(),
					pos: [packet.x, packet.y, packet.z],
				};
			});

			player.on('rel_entity_move', (packet) => {
				const ent = entityStorage[packet.entityId];
				if (ent == undefined) return;
				vec.add(ent.pos, ent.pos, [packet.dX / (128 * 32), packet.dY / (128 * 32), packet.dZ / (128 * 32)]);

				socket.send('EntityMove', {
					uuid: packet.entityId.toString(),
					x: ent.pos[0],
					y: ent.pos[1],
					z: ent.pos[2],
					rotation: 0,
					pitch: 0,
				});
			});

			player.on('entity_move_look', (packet) => {
				const ent = entityStorage[packet.entityId];
				if (ent == undefined) return;
				vec.add(ent.pos, ent.pos, [packet.dX / (128 * 32), packet.dY / (128 * 32), packet.dZ / (128 * 32)]);
				socket.send('EntityMove', {
					uuid: packet.entityId.toString(),
					x: ent.pos[0],
					y: ent.pos[1],
					z: ent.pos[2],
					rotation: 0,
					pitch: 0,
				});
			});

			player.on('entity_teleport', (packet) => {
				const ent = entityStorage[packet.entityId];
				if (ent == undefined) return;
				ent.pos = [packet.x, packet.y, packet.z];
				socket.send('EntityMove', {
					uuid: packet.entityId.toString(),
					x: ent.pos[0],
					y: ent.pos[1],
					z: ent.pos[2],
					rotation: 0,
					pitch: 0,
				});
			});

			player.on('entity_destroy', (packet) => {
				packet.entityIds.forEach((id) => {
					delete entityStorage[id];
					socket.send('EntityRemove', { uuid: id.toString() });
				});
			});

			player.on('block_change', (packet) => {
				socket.send('WorldBlockUpdate', {
					x: packet.location.x,
					y: packet.location.y,
					z: packet.location.z,
					id: mcData.blocksByStateId[packet.type].id,
				});
			});

			player.on('map_chunk', setChunks);

			async function setChunks(p) {
				const id = [Math.floor(p.x / 2), Math.floor(p.z / 2)];
				const idS = id.toString();

				const chunk = new Chunk();
				chunk.load(p.chunkData, p.bitMap, p.skyLightSent, p.groundUp);

				if (chunkStorage[idS] == undefined) {
					chunkStorage[idS] = new ndarray(new Uint16Array(32 * 32 * 256), [32, 256, 32]);
					chunkStorage[idS].t = 0;
				}

				let x, y, z;

				let xa = 0,
					za = 0;

				if (p.x % 2 != 0) xa = 16;
				if (p.z % 2 != 0) za = 16;

				for (x = 0; x < 16; x++) {
					for (z = 0; z < 16; z++) {
						for (y = 0; y < 256; y++) {
							const block = chunk.getBlock(new Vec3(x, y, z));
							chunkStorage[idS].set(x + xa, y, z + za, blockRegistry[block.name] != undefined ? blockRegistry[block.name].rawid : 0);
						}
					}
				}

				chunkStorage[idS].t = chunkStorage[idS].t + 1;

				if (chunkStorage[idS].t > 3) {
					const data: IWorldChunkLoad = {
						x: id[0],
						y: 0,
						z: id[1],
						height: 8,
						compressed: false,
						data: Buffer.from(chunkStorage[idS].data.buffer),
					};

					socket.send('WorldChunkLoad', data);
				}
			}
		});

		setTimeout(() => {
			if (loginTimeout == true) {
				socket.send('PlayerKick', { reason: 'Timeout!' });
				socket.close();
			}
		}, 10000);
	}
}
