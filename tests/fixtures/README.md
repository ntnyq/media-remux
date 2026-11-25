# Media fixtures

Small synthetic FFmpeg-generated media fixtures. They contain generated test patterns/tones, not third-party recordings.

- `video.mp4`: H.264 with B frames, video only.
- `hevc-hvc1.mp4`: Regular MP4 with HEVC B frames and configuration in `hvcC`. Generated with `ffmpeg -f lavfi -i testsrc2=size=96x64:rate=24:duration=1 -an -c:v libx265 -x265-params pools=1:frame-threads=1:log-level=error:open-gop=0:keyint=8 -tag:v hvc1 hevc-hvc1.mp4`.
- `hevc-hev1.mp4`: Fragmented HEVC with in-band parameter sets. Use the `hevc-hvc1.mp4` command with `:repeat-headers=1` appended to the x265 parameters, `-tag:v hev1` and `-movflags +frag_keyframe+empty_moov+default_base_moof`.
- `av1-main10.mp4`: 10-bit Main profile video at 30000/1001 fps, with a sequence header OBU in `av1C`. Generated with `ffmpeg -f lavfi -i testsrc2=size=96x64:rate=30000/1001:duration=1 -an -pix_fmt yuv420p10le -c:v libsvtav1 -preset 11 -g 10 -svtav1-params lp=1 av1-main10.mp4`.
- `vfr-bframes.mp4`: seven H.264 frames with variable frame rate and reordered B frames. The final presented frame is not the final decoded frame. Generated with `ffmpeg -f lavfi -i testsrc2=size=64x64:rate=10 -frames:v 7 -vf 'setpts=N*N' -fps_mode vfr -c:v libx264 -x264-params 'bframes=2:b-adapt=0:keyint=100:min-keyint=100:scenecut=0' -video_track_timescale 1000 -use_editlist 0 vfr-bframes.mp4`.
- `vfr-bframes.flv`: the same variable-rate H.264 payloads in FLV, retaining decode timestamps and composition offsets. Generated with `ffmpeg -i vfr-bframes.mp4 -c copy -f flv vfr-bframes.flv`.
- `progressive-two-audio.mp4`: H.264 with a 48 kHz first AAC track and a 44.1 kHz default AAC track. Generated with `ffmpeg -i video.mp4 -f lavfi -i sine=frequency=440:sample_rate=48000 -f lavfi -i sine=frequency=660:sample_rate=44100 -t 0.5 -map 0:v:0 -map 1:a:0 -map 2:a:0 -c:v copy -c:a aac -disposition:a:0 0 -disposition:a:1 default -movflags +faststart progressive-two-audio.mp4`.
- `fractional-av.mp4`: H.264 at 30000/1001 fps and AAC at 44.1 kHz, used to check edit-list rounding across concatenation and repeated remux. Generated with `ffmpeg -f lavfi -i testsrc2=size=64x64:rate=30000/1001:duration=6.13 -f lavfi -i sine=frequency=440:sample_rate=44100:duration=6.13 -c:v libx264 -g 24 -keyint_min 24 -sc_threshold 0 -c:a aac -b:a 24k fractional-av.mp4`.
- `audio.m4a`: AAC with encoder pre-roll, audio only.
- `aac-pce.flv`: stereo AAC-LC with a program config element in its sequence header. Generated with `ffmpeg -f lavfi -i sine=frequency=440:sample_rate=48000:duration=0.06 -ac 2 -c:a aac -aac_pce 1 -b:a 24k -f flv aac-pce.flv`.
- `subtitle-first.mp4`: fragmented MP4 with a `mov_text` subtitle track before unchanged AAC from `audio.m4a`. The audio `traf` uses the preceding subtitle data's end as its implicit base. Generated with `ffmpeg -i audio.m4a -f srt -i subtitle.srt -map 1 -map 0 -c:a copy -c:s mov_text -movflags empty_moov+frag_keyframe+omit_tfhd_offset subtitle-first.mp4`, using one SRT cue containing `remux regression` from `00:00:00,000` to `00:00:01,000`.
- `progressive.mp4`, `progressive.flv`: progressive H.264/AAC.
- `continuous-av.mpegts` joins five FFmpeg HLS segments in byte order. It contains 30 H.264 pictures with B-frame reordering and 109 AAC-LC frames at 44.1 kHz. The first four segment lengths are 5076, 3572, 5264, and 3384 bytes. Tests derive rollover and cross-PES variants by rewriting the fixture's packet headers and boundaries.

  ```sh
  ffmpeg -f lavfi -i testsrc2=size=64x48:rate=12:duration=2.5 \
    -f lavfi -i sine=frequency=440:sample_rate=44100:duration=2.5 \
    -c:v libx264 -preset fast -x264-params 'aud=1:keyint=16:min-keyint=16:scenecut=0:bframes=2:b-adapt=0' \
    -c:a aac -b:a 24k -hls_time 0.55 -hls_flags split_by_time -hls_list_size 0 \
    -hls_segment_options mpegts_copyts=1 -hls_segment_filename 'part%d.ts' input.m3u8
  cat part0.ts part1.ts part2.ts part3.ts part4.ts > continuous-av.mpegts
  ```

- `progressive.mkv` contains H.264 B frames and 48 kHz AAC-LC with an intentionally delayed audio track and `CodecDelay`. Generated with `ffmpeg -i video.mp4 -itsoffset 0.2 -f lavfi -i sine=frequency=440:sample_rate=48000:duration=1.3 -map 0:v -map 1:a -c:v copy -c:a aac progressive.mkv`.
- `bt709-full-range.mkv` uses the H.264 packets from `video.mp4` with Matroska Colour metadata. Generated with `ffmpeg -i video.mp4 -map 0:v:0 -c:v copy -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range pc bt709-full-range.mkv`.
- `audio-edited-head.m4a` contains an AAC head edit at 0.5 seconds within a packet, with a 330 Hz tone before the edit and 990 Hz after it.

  ```sh
  ffmpeg -f lavfi -i 'aevalsrc=if(lt(t\,0.46)\,0.25*sin(2*PI*330*t)\,0.25*sin(2*PI*990*t)):s=48000:d=1.5' -c:a aac tones.m4a
  ffmpeg -itsoffset -0.5 -i tones.m4a -c copy -avoid_negative_ts disabled audio-edited-head.m4a
  ```

- `progressive-mp3.flv` contains H.264 B frames and 44.1 kHz MP3. Audio starts 125 ms after video. Generated with `ffmpeg -i video.mp4 -itsoffset 0.15 -f lavfi -i sine=frequency=440:sample_rate=44100 -t 0.65 -map 0:v:0 -map 1:a:0 -c:v copy -c:a libmp3lame -f flv progressive-mp3.flv`.
- `progressive-ac3.mp4` contains H.264 B frames and 48 kHz 5.1 AC-3. Audio starts about 194.667 ms after video. Generated with `ffmpeg -i video.mp4 -itsoffset 0.2 -f lavfi -i 'aevalsrc=0.2*sin(2*PI*440*t)|0.2*sin(2*PI*550*t)|0.2*sin(2*PI*660*t)|0.1*sin(2*PI*60*t)|0.1*sin(2*PI*770*t)|0.1*sin(2*PI*880*t):s=48000:d=1.3:c=5.1' -map 0:v:0 -map 1:a:0 -c:v copy -c:a ac3 -b:a 384k -movflags +faststart progressive-ac3.mp4`.
- `mp3-11025hz.flv` contains MPEG-2.5 Layer III with 576 samples per frame. Generated with `ffmpeg -f lavfi -i sine=frequency=440:sample_rate=11025:duration=0.19 -c:a libmp3lame -b:a 24k -f flv mp3-11025hz.flv`.
- `long-gop.mp4`: H.264 for fragment/sample processing.
- `leading-delta.mp4`: H.264 stream copy cut between keyframes, retaining leading dependent frames. Generated from `video.mp4` with `ffmpeg -i video.mp4 -ss 0.1 -copyinkf -c copy -avoid_negative_ts make_zero leading-delta.mp4`.
- `leading-delta-av.mp4`: H.264/AAC stream copy with leading dependent video frames and AAC packets on both sides of the first IDR. Generated with `ffmpeg -i progressive.mp4 -ss 0.1 -copyinkf -c copy -avoid_negative_ts make_zero leading-delta-av.mp4`.
- `leading-delta-mp3.mp4`: H.264/MP3 with dependent video frames before the first IDR and a retained MP3 frame that needs the preceding bit reservoir. Generated in two steps from a synthetic video and a chirp.

  ```sh
  ffmpeg -f lavfi -i "color=c=black:size=160x90:rate=24,drawbox=color=white:t=fill:enable='gte(t,1.25)*lt(mod(t+0.000001,0.25),0.125)'" \
    -f lavfi -i "aevalsrc='if(lt(t,1.1),0.2*sin(2*PI*(240*t+80*t*t)),0.3*sin(2*PI*880*t)*gte(t,1.25)*lt(mod(t,0.25),0.125))':s=44100" \
    -t 3 -c:v libx264 -pix_fmt yuv420p -g 24 -bf 2 \
    -x264-params 'keyint=24:min-keyint=24:scenecut=0:b-adapt=0:open-gop=0' \
    -c:a libmp3lame -b:a 128k full.mp4
  ffmpeg -i full.mp4 -ss 0.1 -map 0 -copyinkf -c copy \
    -avoid_negative_ts make_zero -use_editlist 0 leading-delta-mp3.mp4
  ```

- `hybrid.mp4`: 75 H.264 frames at 25 fps; the first GOP uses ordinary sample tables and the remaining two use `moof` fragments. Generated with `ffmpeg -f lavfi -i testsrc2=size=160x90:rate=25 -t 3 -c:v libx264 -g 25 -keyint_min 25 -sc_threshold 0 -an -movflags frag_keyframe hybrid.mp4`.
- `interlaced.flv`: 320×240 top-field-first H.264, including SPS cropping. Generated with `ffmpeg -f lavfi -i testsrc2=size=320x240:rate=25 -t 1 -c:v libx264 -flags +ilme+ildct -x264-params tff=1 -an -f flv interlaced.flv`.
- `anamorphic.flv`: 320×240 H.264 with 2:1 sample aspect ratio (640×240 display). Generated with `ffmpeg -f lavfi -i testsrc2=size=320x240:rate=25 -t 1 -vf setsar=2/1 -c:v libx264 -an -f flv anamorphic.flv`.
- `bt709-full-range.flv`: one 64×64 H.264 frame with explicit full-range BT.709 SPS color metadata. Generated with `ffmpeg -f lavfi -i color=c=red:size=64x64:rate=1 -frames:v 1 -c:v libx264 -pix_fmt yuv420p -x264-params colorprim=bt709:transfer=bt709:colormatrix=bt709:fullrange=on -an -f flv bt709-full-range.flv`.
- `sar-4-3.flv`, `sar-2-3.flv`: one 64×64 H.264 frame with a 4:3 or 2:3 sample aspect ratio. Generated with `ffmpeg -f lavfi -i color=c=red:size=64x64:rate=1 -frames:v 1 -vf setsar=4/3 -c:v libx264 -an -f flv sar-4-3.flv`; use `setsar=2/3` for the second fixture.
- `encrypted.mp4`: H.264/AAC with CENC-protected sample entries and real encrypted payloads. Generated from `progressive.mp4` with `ffmpeg -i progressive.mp4 -t 0.25 -c copy -encryption_scheme cenc-aes-ctr -encryption_key 00112233445566778899aabbccddeeff -encryption_kid 00112233445566778899aabbccddeeff encrypted.mp4`. The key and KID are public test values. Tests derive unsupported-scheme and missing-IV variants by replacing metadata without changing box extents.

Sparse large-file, sample-table, TFRA and moof fixtures are generated by TypeScript helpers under `tests/helpers`; tests do not allocate multi-gigabyte files.
