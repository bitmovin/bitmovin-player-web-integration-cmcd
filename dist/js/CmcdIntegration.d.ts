/**
 * Collect CMCD data from the Bitmovin Player and add them to the network requests.
 *
 * Limitations:
 * - Range requests aren't supported
 * - It's currently assumed all requests go to the same server
 * - There is no distinguishing between media (ObjectType `a`/`v`/`av`) and initialization (ObjectType `i`) segments
 * - Muxed Audio and Video into a single segment (ObjectType `av`) is not supported
 * - TimedTextTrack (ObjectType `tt`) is currently not used
 */
import { AudioAdaptationData, HttpRequest, HttpRequestType, HttpResponse, HttpResponseBody, PlayerAPI, VideoAdaptationData } from 'bitmovin-player';
import { CmcdCustomKey } from './Cmcd';
export { CmcdCustomKey as CustomKey } from './Cmcd';
export interface CmcdConfig {
    sessionId?: string;
    contentId?: string;
    useQueryArgs?: boolean;
    /**
     * Allows to set custom keys, which will be appended to all requests.
     * This list is static and cannot be changed during run-time.
     *
     * Please note that custom key names MUST carry a hyphenated prefix to ensure
     * that there won't be a namespace collision with future revisions of CMCD.
     * The prefix SHOULD also use a reverse-DNS syntax.
     */
    customKeys?: CmcdCustomKey[];
}
export declare class CmcdIntegration {
    private sessionId;
    private contentId;
    private useQueryArgs;
    private customKeys;
    private player?;
    private stalledSinceLastRequest;
    private currentVideoQuality;
    private currentAudioQuality;
    private isSeekingOrTimeshiftingOrStartup;
    private lastMeasuredThroughputAudio;
    private lastMeasuredThroughputVideo;
    private manifestType;
    constructor(config: CmcdConfig);
    setPlayer(player: PlayerAPI): void;
    onVideoAdaptation: (data: VideoAdaptationData) => string;
    onAudioAdaptation: (data: AudioAdaptationData) => string;
    preprocessHttpRequest: (type: HttpRequestType, request: HttpRequest) => Promise<HttpRequest>;
    preprocessHttpResponse: (type: HttpRequestType, response: HttpResponse<HttpResponseBody>) => Promise<HttpResponse<HttpResponseBody>>;
    setSessionId(id: string): void;
    setContentId(id: string): void;
    private gatherCmcdData;
    private getRequestedMaximumThroughput;
    private getStreamingType;
    private getObjectType;
    private getAudioSegmentRequestSpecificData;
    private getVideoSegmentRequestSpecificData;
    private getNextObjectAndObjectDurationCmcdData;
}
