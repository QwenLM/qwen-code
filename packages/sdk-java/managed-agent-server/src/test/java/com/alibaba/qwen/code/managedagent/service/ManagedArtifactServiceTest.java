package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

class ManagedArtifactServiceTest {
    @Test
    void normalizesRangesWithoutChangingTheRepresentation() {
        assertThat(ManagedArtifactService.select(null, 0))
                .isEqualTo(new ManagedArtifactService.Selection(0, 0, false));
        assertThat(ManagedArtifactService.select("bytes=0-0", 9))
                .isEqualTo(new ManagedArtifactService.Selection(0, 1, true));
        assertThat(ManagedArtifactService.select("bytes=7-", 9))
                .isEqualTo(new ManagedArtifactService.Selection(7, 2, true));
        assertThat(ManagedArtifactService.select("bytes=7-999", 9))
                .isEqualTo(new ManagedArtifactService.Selection(7, 2, true));
        assertThat(ManagedArtifactService.select("bytes=-2", 9))
                .isEqualTo(new ManagedArtifactService.Selection(7, 2, true));
        assertThat(ManagedArtifactService.select("bytes=-999", 9))
                .isEqualTo(new ManagedArtifactService.Selection(0, 9, true));
        assertThat(ManagedArtifactService.select("bytes=0-1048575", 2_000_000).length())
                .isEqualTo(1_048_576);
    }

    @Test
    void refusesInvalidMultipleAndOversizedRangesInsteadOfServingTheWholeOutput() {
        for (String range : new String[] {"", "bytes=-", "bytes=2-1", "bytes=x-9",
                "items=0-1", "bytes=0-1,4-5", "bytes=9223372036854775808-",
                "bytes=0-1048576", "bytes=0-", "bytes=-1048577"}) {
            assertThatThrownBy(() -> ManagedArtifactService.select(range, 2_000_000))
                    .as(range).isInstanceOfSatisfying(ApiException.class,
                            error -> {
                                assertThat(error.getStatus()).isEqualTo(HttpStatus.BAD_REQUEST);
                                String code =
                                        range.contains(",")
                                                ? "unsupported_range"
                                                : java.util.List.of(
                                                                        "bytes=0-1048576",
                                                                        "bytes=0-",
                                                                        "bytes=-1048577")
                                                                .contains(range)
                                                        ? "range_too_large"
                                                        : "invalid_range";
                                assertThat(error.getCode()).isEqualTo(code);
                            });
        }
    }

    @Test
    void distinguishesEmptyAndUnsatisfiableRanges() {
        for (String range : new String[] {"bytes=0-0", "bytes=0-", "bytes=-1"}) {
            assertThatThrownBy(() -> ManagedArtifactService.select(range, 0))
                    .isInstanceOfSatisfying(ApiException.class,
                            error -> assertThat(error.getStatus())
                                    .isEqualTo(HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE));
        }
        for (String range : new String[] {"bytes=9-", "bytes=99-100", "bytes=-0"}) {
            assertThatThrownBy(() -> ManagedArtifactService.select(range, 9))
                    .isInstanceOfSatisfying(ApiException.class,
                            error -> assertThat(error.getStatus())
                                    .isEqualTo(HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE));
        }
    }

    @Test
    void acceptsOnlyMatchingStrongValidators() {
        assertThat(ManagedArtifactService.matches("\"abc\"", "\"abc\"")).isTrue();
        assertThat(ManagedArtifactService.matches("\"other\", \"abc\"", "\"abc\"")).isTrue();
        assertThat(ManagedArtifactService.matches("*", "\"abc\"")).isTrue();
        assertThat(ManagedArtifactService.matches("W/\"abc\"", "\"abc\"")).isFalse();
        assertThat(ManagedArtifactService.matches("\"def\"", "\"abc\"")).isFalse();
    }
}
