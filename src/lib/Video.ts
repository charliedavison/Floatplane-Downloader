import { exec as execCallback, execFile } from 'child_process';
import { createWriteStream } from 'fs';
import { promisify } from 'util';
import fs from 'fs/promises';

const exec = promisify(execCallback);

import { settings, args, fApi } from './helpers.js';

import { htmlToText } from 'html-to-text';
import sanitize from 'sanitize-filename';
import builder from 'xmlbuilder';

import { nPad } from '@inrixia/helpers/math.js';

import type { FilePathFormattingOptions } from './types.js';
import type { BlogPost } from 'floatplane/creator';
import type Channel from './Channel.js';

export default class Video {
	public guid: BlogPost['guid'];
	public title: BlogPost['title'];
	public description: BlogPost['text'];
	public releaseDate: Date;
	public thumbnail: BlogPost['thumbnail'];

	public videoAttachments: BlogPost['videoAttachments'];

	public channel: Channel;

	constructor(video: BlogPost, channel: Channel) {
		this.channel = channel;

		this.guid = video.guid;
		this.videoAttachments = video.attachmentOrder.filter((a) => video.videoAttachments.includes(a));
		this.title = video.title;
		this.description = video.text;
		this.releaseDate = new Date(video.releaseDate);
		this.thumbnail = video.thumbnail;
	}

	private formatString(string: string): string {
		const formatLookup: FilePathFormattingOptions = {
			'%channelTitle%': this.channel.title,
			'%year%': this.releaseDate.getFullYear().toString(),
			'%month%': nPad(this.releaseDate.getMonth() + 1),
			'%day%': nPad(this.releaseDate.getDate()),
			'%hour%': nPad(this.releaseDate.getHours()),
			'%minute%': nPad(this.releaseDate.getMinutes()),
			'%second%': nPad(this.releaseDate.getSeconds()),
			'%videoTitle%': this.title.replace(/ - /g, ' ').replace(/\//g, ' ').replace(/\\/g, ' '),
		};

		for (const [match, value] of Object.entries(formatLookup)) {
			string = string.replace(new RegExp(match, 'g'), value);
		}

		return string;
	}

	private get fullPath(): string {
		return this.formatString(settings.filePathFormatting);
	}

	private get folderPath(): string {
		return this.fullPath.split('/').slice(0, -1).join('/');
	}

	public get filePath(): string {
		return `${this.folderPath}/${sanitize(this.fullPath.split('/').slice(-1)[0])}`;
	}

	/**
	 * Get the suffix for a video file if there are multiple videoAttachments for this video
	 */
	private multiPartSuffix = (attachmentIndex: string | number): string => `${this.videoAttachments.length !== 1 ? ` - Part ${+attachmentIndex + 1}` : ''}`;

	get expectedSize(): number | undefined {
		return this.channel.lookupVideoDB(this.guid).expectedSize;
	}
	set expectedSize(expectedSize: number | undefined) {
		this.channel.lookupVideoDB(this.guid).expectedSize = expectedSize;
	}

	static getFileBytes = async (path: string): Promise<number> => (await fs.stat(path).catch(() => ({ size: -1 }))).size;

	public fileBytes = async (extension: string): Promise<number> => {
		let bytes = 0;
		for (const i in this.videoAttachments) {
			bytes += await Video.getFileBytes(`${this.filePath}${this.multiPartSuffix(i)}.${extension}`);
		}
		return bytes;
	};
	public isDownloaded = async (): Promise<boolean> => (await this.isMuxed()) || (await this.fileBytes('partial')) === this.expectedSize;
	public isMuxed = async (): Promise<boolean> => {
		const fileBytes = await this.fileBytes('mp4');
		// If considerAllNonPartialDownloaded is true, return true if the file exists. Otherwise check if the file is the correct size
		if (settings.considerAllNonPartialDownloaded) return fileBytes !== -1;
		return fileBytes === this.expectedSize;
	};

	public async download(quality: string, allowRangeQuery = true): Promise<ReturnType<typeof fApi.got.stream>[]> {
		if (await this.isDownloaded()) throw new Error(`Attempting to download "${this.title}" video already downloaded!`);

		// Make sure the folder for the video exists
		await fs.mkdir(this.folderPath, { recursive: true });

		// If downloading artwork is enabled download it
		if (settings.extras.downloadArtwork && this.thumbnail !== null) {
			const artworkFile = `${this.filePath}${settings.artworkSuffix}.png`;
			fApi.got
				.stream(this.thumbnail.path)
				.pipe(createWriteStream(artworkFile))
				.once('end', () => fs.utimes(artworkFile, new Date(), this.releaseDate));
		} // Save the thumbnail with the same name as the video so plex will use it

		if (settings.extras.saveNfo) {
			let season = '';
			let episode = '';
			const match = /- S(.+)E(.+) -/i.exec(this.fullPath);
			if (match !== null) {
				season = match[1];
				episode = match[2];
			}
			const nfo = builder
				.create('episodedetails')
				.ele('title')
				.text(this.title)
				.up()
				.ele('showtitle')
				.text(this.channel.title)
				.up()
				.ele('description')
				.text(htmlToText(this.description))
				.up()
				.ele('plot') // Kodi/Plex NFO format uses `plot` as the episode description
				.text(htmlToText(this.description))
				.up()
				.ele('aired') // format: yyyy-mm-dd required for Kodi/Plex
				.text(this.releaseDate.getFullYear().toString() + '-' + nPad(this.releaseDate.getMonth() + 1) + '-' + nPad(this.releaseDate.getDate()))
				.up()
				.ele('season')
				.text(season)
				.up()
				.ele('episode')
				.text(episode)
				.up()
				.end({ pretty: true });
			await fs.writeFile(`${this.filePath}.nfo`, nfo, 'utf8');
			await fs.utimes(`${this.filePath}.nfo`, new Date(), this.releaseDate);
		}

		let writeStreamOptions, requestOptions, downloadedBytes;
		// Disable download resumption as floatplane has a poor history of edges failing to support it causing issues
		// // Download resumption is not currently supported for multi part videos...
		// if (this.videoAttachments.length === 1) {
		// 	// Handle download resumption if video was partially downloaded
		// 	if (allowRangeQuery && this.expectedSize !== undefined && (downloadedBytes = await this.fileBytes('partial')) !== -1) {
		// 		[writeStreamOptions, requestOptions] = [{ start: downloadedBytes, flags: 'r+' }, { headers: { range: `bytes=${downloadedBytes}-${this.expectedSize}` } }];
		// 	}
		// }

		let downloadRequests = [];
		for (const i in this.videoAttachments) {
			// Send download request video, assume the first video attached is the actual video as most will not have more than one video
			const cdnInfo = await fApi.cdn.delivery('download', this.videoAttachments[i]);

			// Pick a random edge to download off, eventual even distribution
			if (cdnInfo.edges === undefined) throw new Error('No edges found for video');
			const downloadEdge = cdnInfo.edges[Math.floor(Math.random() * cdnInfo.edges.length)];
			if (settings.floatplane.downloadEdge !== '') downloadEdge.hostname = settings.floatplane.downloadEdge;

			// Convert the qualities into an array of resolutions and sorts them smallest to largest
			const availableQualities = cdnInfo.resource.data.qualityLevels.map((quality) => quality.name).sort((a, b) => +b - +a);

			// Set the quality to use based on whats given in the settings.json or the highest available
			const downloadQuality = availableQualities.includes(quality) ? quality : availableQualities[0];

			const downloadRequest = fApi.got.stream(
				`https://${downloadEdge.hostname}${cdnInfo.resource.uri.replace('{qualityLevels}', downloadQuality).replace('{token}', cdnInfo.resource.data.token)}`,
				requestOptions
			);
			// Pipe the download to the file once response starts
			downloadRequest.pipe(createWriteStream(`${this.filePath}${this.multiPartSuffix(i)}.partial`, writeStreamOptions));
			// Set the videos expectedSize once we know how big it should be for download validation.
			if (this.expectedSize === undefined) downloadRequest.once('downloadProgress', (progress) => (this.expectedSize = progress.total));
			downloadRequests.push(downloadRequest);
		}

		return downloadRequests;
	}

	public async markCompleted(): Promise<void> {
		if (!(await this.isMuxed()))
			throw new Error(
				`Cannot mark ${this.title} as completed as video file size is not correct. Expected: ${this.expectedSize} bytes, Got: ${await this.fileBytes(
					'mp4'
				)} bytes...`
			);
		return this.channel.markVideoCompleted(this.guid, this.releaseDate.getTime());
	}

	get ffmpegDesc() {
		return htmlToText(this.description);
	}

	public async muxffmpegMetadata(): Promise<void> {
		if (!this.isDownloaded())
			throw new Error(
				`Cannot mux ffmpeg metadata for ${this.title} as its not downloaded. Expected: ${this.expectedSize}, Got: ${await this.fileBytes('partial')} bytes...`
			);
		await Promise.all(
			this.videoAttachments.map(
				(a, i) =>
					new Promise((resolve, reject) =>
						execFile(
							args.headless === true ? './ffmpeg' : './db/ffmpeg',
							[
								'-i',
								`${this.filePath}${this.multiPartSuffix(i)}.partial`,
								'-metadata',
								`title=${this.title}${this.multiPartSuffix(i)}`,
								'-metadata',
								`AUTHOR=${this.channel.title}`,
								'-metadata',
								`YEAR=${this.releaseDate.getFullYear().toString()}`,
								'-metadata',
								`date=${this.releaseDate.getFullYear().toString() + nPad(this.releaseDate.getMonth() + 1) + nPad(this.releaseDate.getDate())}`,
								'-metadata',
								`description=${this.ffmpegDesc}`,
								'-metadata',
								`synopsis=${this.ffmpegDesc}`,
								'-c:a',
								'copy',
								'-c:v',
								'copy',
								`${this.filePath}${this.multiPartSuffix(i)}.mp4`,
							],
							(error, stdout, stderr) => {
								if (error !== null) {
									error.message ??= '';
									error.message += stderr;
									reject(error);
								} else resolve(stdout);
							}
						)
					)
			)
		);
		this.expectedSize = await this.fileBytes('mp4');
		await this.markCompleted();
		for (const i in this.videoAttachments) {
			await fs.unlink(`${this.filePath}${this.multiPartSuffix(i)}.partial`);
			// Set the files update time to when the video was released
			await fs.utimes(`${this.filePath}${this.multiPartSuffix(i)}.mp4`, new Date(), this.releaseDate);
		}
	}

	public async postProcessingCommand(): Promise<void> {
		const result = await exec(this.formatString(settings.postProcessingCommand));
		if (result.stderr !== '') throw new Error(result.stderr);
	}
}
