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
export interface CmcdConfig {
    sessionId?: string;
    contentId?: string;
    useQueryArgs?: boolean;
}
export declare class CmcdIntegration {
    private sessionId;
    private contentId;
    private useQueryArgs;
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
